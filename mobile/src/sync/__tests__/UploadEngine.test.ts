import { MAX_IMAGE_BYTES } from '../../domain/limits';
import type { LocalReport } from '../../domain/report';
import { UploadEngine, type EngineConfig } from '../UploadEngine';
import type { Connectivity, UploadTransport } from '../ports';
import { FakeServer, sha256 } from './fakes/FakeServer';
import { InMemoryReportStore } from './fakes/InMemoryReportStore';
import { makeReport, MemoryFiles } from './fakes/fixtures';

const FAST: Partial<EngineConfig> = {
  chunkBytes: 1_000,
  requestTimeoutMs: 50,
  minBytesPerSec: 1e9,
  backoff: { baseMs: 1, maxMs: 4 },
  offlinePollMs: 60_000,
};

const engines: UploadEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map(engine => engine.stop()));
});

function setup(
  reports: (disk: MemoryFiles) => LocalReport[],
  options: { connectivity?: Connectivity; config?: Partial<EngineConfig> } = {},
) {
  const files = new MemoryFiles();
  const store = InMemoryReportStore.with(reports(files));
  const server = new FakeServer();
  const engine = createEngine(store, server, files, options);
  return { files, store, server, engine };
}

function createEngine(
  store: InMemoryReportStore,
  transport: UploadTransport,
  files: MemoryFiles,
  options: { connectivity?: Connectivity; config?: Partial<EngineConfig> } = {},
) {
  const engine = new UploadEngine({
    store,
    transport,
    files,
    connectivity: options.connectivity,
    config: { ...FAST, ...options.config },
  });
  engines.push(engine);
  return engine;
}

/** Keeps kicking the engine (ignoring backoff) until the outbox is empty. */
async function settle(engine: UploadEngine, store: InMemoryReportStore, rounds = 200): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await engine.drain({ ignoreBackoff: true });
    if ((await store.listPending()).length === 0) return;
  }
  throw new Error(
    `outbox did not drain: ${JSON.stringify((await store.listPending()).map(r => [r.id, r.status, r.lastError]))}`,
  );
}

function expectDeliveredIntact(
  server: FakeServer,
  store: InMemoryReportStore,
  files: MemoryFiles,
  report: LocalReport,
) {
  const stored = server.reports.get(report.id);
  expect(stored).toBeDefined();
  expect(stored!.imageIds).toEqual(report.images.map(image => image.id));
  for (const image of report.images) {
    expect(sha256(server.imageBytes(image.id)!)).toBe(sha256(files.files.get(image.uri)!));
  }
  expect(store.get(report.id)!.status).toBe('uploaded');
}

describe('UploadEngine: happy path', () => {
  it('uploads every image in chunks, then commits', async () => {
    const { store, server, files, engine } = setup(disk => [makeReport(disk, { imageSizes: [2_500, 4_000] })]);
    const [report] = store.all();
    await engine.start();

    expectDeliveredIntact(server, store, files, report!);
    expect(server.calls.chunk).toBe(3 + 4);
    expect(server.bytesReceived).toBe(6_500);
    expect(store.get(report!.id)!.uploadedAt).not.toBeNull();
    expect(engine.getActivity()).toEqual({ state: 'idle' });
  });

  it('delivers oldest first', async () => {
    const { store, server, engine } = setup(disk => [
      makeReport(disk, { createdAt: '2026-11-02T10:00:00.000Z' }),
      makeReport(disk, { createdAt: '2026-11-02T09:00:00.000Z' }),
    ]);
    await engine.start();
    const order = [...server.reports.values()].map(r => r.id);
    expect(order).toEqual(
      store
        .all()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(r => r.id),
    );
  });
});

describe('UploadEngine: nothing lands twice', () => {
  it('a lost chunk response skips ahead instead of resending', async () => {
    const { store, server, files, engine } = setup(disk => [makeReport(disk, { imageSizes: [5_000] })]);
    server.fail('chunk', 'lose-response', 2);
    await settle(engine, store);
    expectDeliveredIntact(server, store, files, store.all()[0]!);
    expect(server.bytesReceived).toBe(5_000);
  });

  it('a lost commit response does not create a second report', async () => {
    const { store, server, files, engine } = setup(disk => [makeReport(disk)]);
    server.fail('commit', 'lose-response');
    await settle(engine, store);
    expect(server.calls.commit).toBe(2);
    expect(server.reports.size).toBe(1);
    expectDeliveredIntact(server, store, files, store.all()[0]!);
  });

  it('re-sends images the server reports missing at commit', async () => {
    const { store, server, files, engine } = setup(disk => [makeReport(disk, { imageSizes: [2_000, 2_000] })]);
    const report = store.all()[0]!;
    server.fail('commit', { status: 503 });
    await engine.drain(); // images land, commit fails
    server.forget(report.images[1]!.id);
    await settle(engine, store);
    expectDeliveredIntact(server, store, files, report);
  });
});

describe('UploadEngine: nothing is lost', () => {
  // This report takes exactly 12 store writes; die at every one of them. Write 12 is the cruel
  // one: the server has the report but the phone dies before recording that.
  it.each(Array.from({ length: 12 }, (_, i) => i + 1))(
    'resumes after the process dies at write %i without resending stored bytes',
    async killAt => {
      const files = new MemoryFiles();
      const report = makeReport(files, { imageSizes: [3_500, 2_000] });
      const firstLife = InMemoryReportStore.with([report]).killAfterWrites(killAt - 1);
      const server = new FakeServer();

      await createEngine(firstLife, server, files)
        .start()
        .catch(() => {});
      expect(firstLife.dead).toBe(true);

      const secondLife = firstLife.reopen();
      await settle(createEngine(secondLife, server, files), secondLife);
      expectDeliveredIntact(server, secondLife, files, report);
      expect(server.bytesReceived).toBe(5_500);
      expect(server.reports.size).toBe(1);
    },
  );

  it('a hung request times out and is retried', async () => {
    const { store, server, files, engine } = setup(disk => [makeReport(disk)]);
    server.fail('chunk', 'hang');
    await engine.start();
    expect(store.all()[0]!.lastError?.reason).toBe('timeout');
    await settle(engine, store);
    expectDeliveredIntact(server, store, files, store.all()[0]!);
  });

  it('does not touch the network while offline, then resumes when kicked', async () => {
    let offline = true;
    const { store, server, files, engine } = setup(disk => [makeReport(disk)], {
      connectivity: { isOffline: async () => offline },
    });
    await engine.start();
    expect(server.calls.declare).toBe(0);
    expect(engine.getActivity()).toEqual({ state: 'offline' });

    offline = false;
    await engine.drain({ ignoreBackoff: true });
    expectDeliveredIntact(server, store, files, store.all()[0]!);
  });

  it("a connection failure ends the pass instead of burning every report's attempts", async () => {
    const { store, server, engine } = setup(disk => [makeReport(disk), makeReport(disk)]);
    server.fail('declare', 'drop');
    await engine.drain();
    const [first, second] = store.all().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(first!.attempts).toBe(1);
    expect(second!.attempts).toBe(0);
  });
});

describe('UploadEngine: retry policy', () => {
  it.each([503, 500, 408, 429])('retries %i', async status => {
    const { store, server, files, engine } = setup(disk => [makeReport(disk)]);
    server.fail('chunk', { status }, 2);
    await settle(engine, store);
    expectDeliveredIntact(server, store, files, store.all()[0]!);
  });

  it.each([
    [400, 'rejected'],
    [422, 'rejected'],
    [413, 'too_large'],
  ])('does not retry %i; marks it failed and moves on to the next report', async (status, reason) => {
    const { store, server, engine } = setup(disk => [
      makeReport(disk, { createdAt: '2026-11-02T09:00:00.000Z' }),
      makeReport(disk, { createdAt: '2026-11-02T10:00:00.000Z' }),
    ]);
    server.fail('declare', { status });
    await engine.start();
    const [refused, next] = store.all().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(refused!.status).toBe('failed');
    expect(refused!.lastError).toMatchObject({ reason, retryable: false });
    expect(next!.status).toBe('uploaded');

    const declares = server.calls.declare;
    await engine.drain({ ignoreBackoff: true });
    expect(server.calls.declare).toBe(declares);
  });

  it('backs off after failures, and progress resets the ladder', async () => {
    const { store, server, engine } = setup(disk => [makeReport(disk, { imageSizes: [3_000] })], {
      config: { backoff: { baseMs: 10_000, maxMs: 60_000 } },
    });
    const id = store.all()[0]!.id;

    server.fail('declare', { status: 503 });
    await engine.drain();
    expect(store.get(id)!.attempts).toBe(1);
    server.fail('declare', { status: 503 });
    await engine.drain({ ignoreBackoff: true });
    const afterTwo = store.get(id)!;
    expect(afterTwo.attempts).toBe(2);
    expect(afterTwo.nextAttemptAt! - Date.now()).toBeGreaterThan(9_000);

    // not due yet: nothing happens
    const declares = server.calls.declare;
    await engine.drain();
    expect(server.calls.declare).toBe(declares);

    // one chunk lands, then the connection drops: moving slowly isn't failing, ladder resets
    server.fail('chunk', 'drop', 1, { skip: 1 });
    await engine.drain({ ignoreBackoff: true });
    expect(store.get(id)!.attempts).toBe(1);
    expect(store.get(id)!.images[0]!.uploadedBytes).toBe(1_000);
  });
});

describe('UploadEngine: contract enforcement', () => {
  it('never sends an image over 5 MB, even if one reached the outbox', async () => {
    const { store, server, engine } = setup(disk => {
      const report = makeReport(disk);
      report.images[0]!.size = MAX_IMAGE_BYTES + 1;
      return [report];
    });
    await engine.start();
    expect(server.calls.declare).toBe(0);
    expect(store.all()[0]!).toMatchObject({ status: 'failed', lastError: { reason: 'too_large' } });
  });

  it('marks a report failed when its photo vanished from disk', async () => {
    const { store, files, engine } = setup(disk => [makeReport(disk)]);
    files.files.clear();
    await engine.start();
    expect(store.all()[0]!).toMatchObject({ status: 'failed', lastError: { reason: 'file_missing' } });
  });
});

describe('UploadEngine: stop()', () => {
  it('discards in-flight results instead of writing them back', async () => {
    const { store, server, engine } = setup(disk => [makeReport(disk)], { config: { requestTimeoutMs: 10_000 } });
    server.fail('chunk', 'hang');
    const started = engine.start();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 20));
    expect(engine.getActivity().state).toBe('uploading');

    const before = store.all()[0]!;
    await engine.stop();
    await started;
    expect(store.all()[0]).toEqual(before);
    expect(engine.getActivity()).toEqual({ state: 'idle' });
  });
});
