import { MAX_IMAGES, MAX_IMAGE_BYTES, MIN_IMAGES } from '../domain/limits';
import type { LocalImage, LocalReport } from '../domain/report';
import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from './backoff';
import { classify, ContractViolation, TransportError, type Failure } from './errors';
import type {
  Clock,
  Connectivity,
  FileReader,
  Logger,
  ReportStore,
  Scheduler,
  UploadState,
  UploadTransport,
} from './ports';

export interface EngineConfig {
  /** Bytes per PATCH. Small enough that a dropped 2G connection costs seconds, not minutes. */
  chunkBytes: number;
  /** Every request gets this long before we assume it is hung… */
  requestTimeoutMs: number;
  /** …plus time to move its body at this pessimistic rate. */
  minBytesPerSec: number;
  backoff: BackoffPolicy;
  /** A corrupted assembly is retried this many times before the report is marked failed. */
  maxChecksumRetries: number;
  /** While offline we wait for a reconnect kick, but also re-check this often in case it never comes. */
  offlinePollMs: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  chunkBytes: 64 * 1024,
  requestTimeoutMs: 30_000,
  minBytesPerSec: 1_000,
  backoff: DEFAULT_BACKOFF,
  maxChecksumRetries: 3,
  offlinePollMs: 60_000,
};

export type EngineActivity =
  | { state: 'idle' }
  | { state: 'offline' }
  | { state: 'uploading'; reportId: string }
  | { state: 'waiting'; nextAttemptAt: number };

export interface UploadEngineDeps {
  store: ReportStore;
  transport: UploadTransport;
  files: FileReader;
  connectivity?: Connectivity;
  clock?: Clock;
  scheduler?: Scheduler;
  logger?: Logger;
  random?: () => number;
  config?: Partial<EngineConfig>;
}

type Outcome = 'delivered' | 'retry-later' | 'failed' | 'superseded';

/** Thrown internally when stop()/reset happened while a delivery was in flight. */
class Superseded extends Error {}

const SILENT: Logger = { info: () => {}, warn: () => {} };

/**
 * Drains the outbox, one report at a time, oldest first.
 *
 * Guarantees, and where they come from:
 *  - nothing lost:       every step is persisted before the next starts; the store is the queue
 *  - nothing twice:      ids are client-generated; the server dedupes images and reports by id,
 *                        and a report only becomes visible at an atomic, idempotent commit
 *  - progress on 2G:     images move in small chunks and resume from the server's offset
 *  - survives a kill:    recoverInterrupted() on start; the server's offset is the truth
 *
 * Single-flight: concurrent drain() calls coalesce into one loop. A generation counter makes
 * stop() final: results from anything that was in flight are discarded, never written back.
 */
export class UploadEngine {
  private readonly config: EngineConfig;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly logger: Logger;
  private readonly random: () => number;

  private generation = 0;
  private running: Promise<void> | null = null;
  private rerunRequested = false;
  private ignoreBackoffNext = false;
  private delivery: AbortController | null = null;
  private wakeTimer: unknown = null;
  /** Set by stop(); cleared by start(). A fresh engine accepts drains. */
  private stopped = false;
  private activity: EngineActivity = { state: 'idle' };
  private readonly listeners = new Set<(activity: EngineActivity) => void>();

  constructor(private readonly deps: UploadEngineDeps) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...deps.config };
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.scheduler = deps.scheduler ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.logger = deps.logger ?? SILENT;
    this.random = deps.random ?? Math.random;
  }

  /** Recover anything a previous process left mid-flight, then start draining. */
  async start(): Promise<void> {
    this.stopped = false;
    const recovered = await this.deps.store.recoverInterrupted();
    if (recovered > 0) this.logger.info('recovered interrupted reports', { recovered });
    await this.drain();
  }

  /**
   * Run until nothing is due. Safe to call from anywhere, any number of times:
   * app start, reconnect, foreground, a new report, a background task.
   * `ignoreBackoff` retries immediately, e.g. because the network just came back.
   */
  drain(options: { ignoreBackoff?: boolean } = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (options.ignoreBackoff) this.ignoreBackoffNext = true;
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    this.clearWake();
    const generation = this.generation;
    this.running = this.loop(generation).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Abort in-flight work and discard its results. Used before a reset and on teardown. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.clearWake();
    this.delivery?.abort();
    await this.running?.catch(() => {});
    this.setActivity({ state: 'idle' });
  }

  getActivity(): EngineActivity {
    return this.activity;
  }

  subscribe(listener: (activity: EngineActivity) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- loop ------------------------------------------------------------------------------

  private async loop(generation: number): Promise<void> {
    try {
      do {
        this.rerunRequested = false;
        const ignoreBackoff = this.ignoreBackoffNext;
        this.ignoreBackoffNext = false;
        await this.pass(generation, ignoreBackoff);
      } while (this.rerunRequested && generation === this.generation);
      if (generation === this.generation) await this.scheduleWake();
    } catch (error) {
      // The store itself failed (disk full, db locked). Nothing is lost: try again later.
      this.logger.warn('drain failed', { error: String(error) });
      if (generation === this.generation) this.wakeIn(this.config.backoff.maxMs);
    }
  }

  private async pass(generation: number, ignoreBackoff: boolean): Promise<void> {
    const pending = await this.deps.store.listPending();
    for (const report of pending) {
      if (generation !== this.generation) return;
      const due = ignoreBackoff || report.nextAttemptAt === null || report.nextAttemptAt <= this.clock.now();
      if (!due) continue;
      if (await this.deps.connectivity?.isOffline()) return;

      const { outcome, failure } = await this.deliver(report, generation);
      // A connection-level failure will hit the next report too; stop and keep FIFO order.
      if (outcome === 'retry-later' && (failure?.reason === 'network' || failure?.reason === 'timeout')) return;
    }
  }

  private async scheduleWake(): Promise<void> {
    const pending = await this.deps.store.listPending();
    if (pending.length === 0) return this.setActivity({ state: 'idle' });
    if (await this.deps.connectivity?.isOffline()) {
      this.setActivity({ state: 'offline' });
      return this.wakeIn(this.config.offlinePollMs);
    }
    const now = this.clock.now();
    const next = Math.min(...pending.map(report => report.nextAttemptAt ?? now));
    this.setActivity({ state: 'waiting', nextAttemptAt: next });
    this.wakeIn(Math.max(0, next - now));
  }

  private wakeIn(ms: number): void {
    this.clearWake();
    this.wakeTimer = this.scheduler.setTimeout(() => {
      this.wakeTimer = null;
      this.drain(); // never rejects: loop() catches everything
    }, ms);
  }

  private clearWake(): void {
    if (this.wakeTimer !== null) this.scheduler.clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  // ---- one report ------------------------------------------------------------------------

  private async deliver(report: LocalReport, generation: number): Promise<{ outcome: Outcome; failure?: Failure }> {
    const { store, transport } = this.deps;
    const delivery = new AbortController();
    this.delivery = delivery;
    const progress = { made: false };
    this.setActivity({ state: 'uploading', reportId: report.id });

    try {
      assertContract(report);
      await store.updateReport(report.id, { status: 'uploading' });

      const images = [...report.images].sort((a, b) => a.position - b.position);
      for (const image of images) {
        if (!image.uploaded) await this.uploadImage(report, image, generation, delivery.signal, progress);
      }

      this.ensureCurrent(generation, delivery.signal);
      await store.updateReport(report.id, { status: 'committing' });
      const result = await this.request(delivery.signal, this.config.requestTimeoutMs, signal =>
        transport.commitReport(
          {
            id: report.id,
            description: report.description,
            createdAt: report.createdAt,
            images: images.map(image => ({ id: image.id, position: image.position })),
          },
          signal,
        ),
      );
      this.ensureCurrent(generation, delivery.signal);
      await store.updateReport(report.id, {
        status: 'uploaded',
        uploadedAt: result.receivedAt,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
      });
      this.logger.info('report delivered', { reportId: report.id, created: result.created });
      return { outcome: 'delivered' };
    } catch (error) {
      if (error instanceof Superseded || generation !== this.generation) return { outcome: 'superseded' };
      return this.recordFailure(report, error, progress.made);
    } finally {
      if (this.delivery === delivery) this.delivery = null;
    }
  }

  private async uploadImage(
    report: LocalReport,
    image: LocalImage,
    generation: number,
    signal: AbortSignal,
    progress: { made: boolean },
  ): Promise<void> {
    const { store, transport, files } = this.deps;
    const declare = () =>
      this.request(signal, this.config.requestTimeoutMs, s =>
        transport.declareImage(
          { imageId: image.id, reportId: report.id, size: image.size, sha256: image.sha256, mimeType: 'image/jpeg' },
          s,
        ),
      );

    // The server's offset is the truth: our local uploadedBytes may lag a lost response.
    let state: UploadState = await declare();
    let checksumFailures = 0;

    while (!state.complete) {
      this.ensureCurrent(generation, signal);
      const offset = state.offset;
      const length = Math.min(this.config.chunkBytes, image.size - offset);
      if (length <= 0) throw new Error(`Server offset ${offset} is past the end of ${image.id} (${image.size} bytes)`);

      const bytes = await files.read(image.uri, offset, length);
      try {
        state = await this.request(signal, this.timeoutFor(length), s =>
          transport.sendChunk(image.id, offset, bytes, s),
        );
      } catch (error) {
        if (!(error instanceof TransportError) || error.kind !== 'http') throw error;
        if (error.code === 'offset_mismatch' && typeof error.body?.offset === 'number') {
          // Our previous chunk landed but its response didn't. Skip ahead; never resend stored bytes.
          state = { offset: error.body.offset, complete: false };
        } else if (error.code === 'checksum_mismatch' && checksumFailures < this.config.maxChecksumRetries) {
          checksumFailures += 1;
          state = { offset: 0, complete: false };
        } else if (error.code === 'upload_not_found') {
          state = await declare();
        } else {
          throw error;
        }
      }
      if (state.offset > offset) progress.made = true;
      this.ensureCurrent(generation, signal);
      await store.updateImage(image.id, { uploadedBytes: state.offset });
    }

    this.ensureCurrent(generation, signal);
    await store.updateImage(image.id, { uploaded: true, uploadedBytes: image.size });
  }

  private async recordFailure(
    report: LocalReport,
    error: unknown,
    progressMade: boolean,
  ): Promise<{ outcome: Outcome; failure: Failure }> {
    const { store } = this.deps;
    const failure = classify(error);
    const lastError = {
      reason: failure.reason,
      message: failure.message,
      retryable: failure.retryable,
      at: new Date(this.clock.now()).toISOString(),
    };

    if (error instanceof TransportError && error.code === 'images_incomplete') {
      for (const imageId of error.body?.missing ?? [])
        await store.updateImage(imageId, { uploaded: false, uploadedBytes: 0 });
    }

    if (!failure.retryable) {
      this.logger.warn('report failed permanently', {
        reportId: report.id,
        reason: failure.reason,
        message: failure.message,
      });
      await store.updateReport(report.id, { status: 'failed', nextAttemptAt: null, lastError });
      return { outcome: 'failed', failure };
    }

    // Moving, even slowly, isn't failing: progress resets the backoff ladder.
    const attempts = progressMade ? 1 : report.attempts + 1;
    const delay = Math.max(backoffDelay(attempts, this.config.backoff, this.random), failure.retryAfterMs ?? 0);
    this.logger.info('report will retry', { reportId: report.id, reason: failure.reason, attempts, delay });
    await store.updateReport(report.id, {
      status: 'queued',
      attempts,
      nextAttemptAt: this.clock.now() + delay,
      lastError,
    });
    return { outcome: 'retry-later', failure };
  }

  // ---- plumbing --------------------------------------------------------------------------

  /**
   * Runs one transport call with a hard deadline. The race means even a transport that
   * ignores its AbortSignal can't wedge the queue: a hung request is abandoned, then retried.
   */
  private async request<T>(
    parent: AbortSignal,
    timeoutMs: number,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      controller.abort();
      rejectAbort(timedOut ? new TransportError('timeout', `No response after ${timeoutMs}ms`) : new Superseded());
    };
    if (parent.aborted) throw new Superseded();
    parent.addEventListener('abort', onAbort);
    const timer = this.scheduler.setTimeout(() => {
      timedOut = true;
      onAbort();
    }, timeoutMs);
    try {
      const pending = call(controller.signal);
      pending.catch(() => {}); // if we abandon it, its late rejection is expected, not unhandled
      return await Promise.race([pending, aborted]);
    } catch (error) {
      if (timedOut) throw new TransportError('timeout', `No response after ${timeoutMs}ms`);
      throw error;
    } finally {
      this.scheduler.clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    }
  }

  private timeoutFor(bytes: number): number {
    return this.config.requestTimeoutMs + Math.ceil((bytes / this.config.minBytesPerSec) * 1000);
  }

  private ensureCurrent(generation: number, signal: AbortSignal): void {
    if (generation !== this.generation || signal.aborted) throw new Superseded();
  }

  private setActivity(activity: EngineActivity): void {
    if (JSON.stringify(activity) === JSON.stringify(this.activity)) return;
    this.activity = activity;
    for (const listener of this.listeners) listener(activity);
  }
}

function assertContract(report: LocalReport): void {
  if (!report.description.trim()) throw new ContractViolation('rejected', 'Report has no description');
  if (report.images.length < MIN_IMAGES || report.images.length > MAX_IMAGES) {
    throw new ContractViolation(
      'rejected',
      `Report has ${report.images.length} photos; allowed ${MIN_IMAGES}–${MAX_IMAGES}`,
    );
  }
  const oversized = report.images.find(image => image.size > MAX_IMAGE_BYTES);
  if (oversized) throw new ContractViolation('too_large', `Photo ${oversized.position + 1} is over the 5 MB limit`);
}
