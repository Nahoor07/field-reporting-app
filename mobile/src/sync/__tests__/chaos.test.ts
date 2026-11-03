import { UploadEngine } from '../UploadEngine';
import { FakeServer, sha256 } from './fakes/FakeServer';
import { InMemoryReportStore } from './fakes/InMemoryReportStore';
import { makeReport, MemoryFiles, mulberry32 } from './fakes/fixtures';

/**
 * The assessment's main scenario, randomised: three reports (one with five photos),
 * a server that drops, hangs, loses responses and throws 5xx/429 on ~30% of calls,
 * and a process that gets force-quit at random points. Each seed is reproducible.
 */
const SEEDS = Array.from({ length: 40 }, (_, i) => 1_000 + i);

describe('chaos: random faults and random kills', () => {
  it.each(SEEDS)('seed %i: every report lands exactly once, every image intact', async seed => {
    const random = mulberry32(seed);
    const size = () => 1_000 + Math.floor(random() * 7_000);
    const files = new MemoryFiles();
    const reports = [
      makeReport(files, { imageSizes: [size(), size(), size(), size(), size()], random }),
      makeReport(files, { imageSizes: [size()], random }),
      makeReport(files, { imageSizes: [size(), size()], random }),
    ];
    const server = new FakeServer().enableChaos(0.3, random);
    let store = InMemoryReportStore.with(reports);
    let kills = 0;

    for (let life = 0; life < 100; life++) {
      store = store.reopen();
      if (random() < 0.5) store.killAfterWrites(Math.floor(random() * 15));
      const engine = new UploadEngine({
        store,
        transport: server,
        files,
        random,
        config: { chunkBytes: 1_500, requestTimeoutMs: 20, minBytesPerSec: 1e9, backoff: { baseMs: 1, maxMs: 2 } },
      });
      await engine.start().catch(() => {});
      for (let kick = 0; kick < 3 && !store.dead; kick++) await engine.drain({ ignoreBackoff: true });
      await engine.stop();
      if (store.dead) kills += 1;
      else if ((await store.listPending()).length === 0) break;
    }

    expect(await store.reopen().listPending()).toEqual([]);
    expect(server.reports.size).toBe(3);
    for (const report of reports) {
      expect(server.reports.get(report.id)!.imageIds).toEqual(report.images.map(image => image.id));
      for (const image of report.images) {
        expect(sha256(server.imageBytes(image.id)!)).toBe(image.sha256);
      }
      expect(store.get(report.id)!.status).toBe('uploaded');
    }
    // Nothing the server already stored was ever sent again, however often we were killed.
    const totalBytes = reports.flatMap(report => report.images).reduce((sum, image) => sum + image.size, 0);
    expect(server.bytesReceived).toBe(totalBytes);
    totalKills += kills;
  });

  afterAll(() => {
    // Guard against the test quietly becoming a happy-path test.
    expect(totalKills).toBeGreaterThan(SEEDS.length);
  });
});

let totalKills = 0;
