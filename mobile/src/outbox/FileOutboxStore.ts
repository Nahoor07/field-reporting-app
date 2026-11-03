import { isPending, type LocalImage, type LocalReport } from '../domain/report';
import type { ImagePatch, ReportPatch, ReportStore } from '../sync/ports';
import { join, type Disk } from '../platform/disk';

/**
 * The durable outbox: one directory per report.
 *
 *   <root>/<reportId>/report.json      the manifest (written atomically: temp + rename)
 *   <root>/<reportId>/<imageId>.jpg    processed photos, already under the 5 MB ceiling
 *
 * A report enters the outbox by *renaming* a fully-written staging directory into <root>.
 * Rename is atomic, so after a crash a report either exists completely or not at all.
 *
 * On disk, images store only their file name; the absolute uri is resolved on load. That
 * keeps manifests valid if the OS moves the app container (it does, on iOS updates).
 *
 * All mutations go through one serial queue, so the engine's per-chunk progress writes and
 * a user's "retry" or "delete" can never interleave into a torn manifest.
 */
export interface OutboxSnapshot {
  /** Newest first, for display. */
  reports: LocalReport[];
  loaded: boolean;
}

type DiskImage = Omit<LocalImage, 'uri'> & { file: string };
type DiskReport = Omit<LocalReport, 'images'> & { images: DiskImage[] };

const MANIFEST = 'report.json';

export class FileOutboxStore implements ReportStore {
  private readonly reports = new Map<string, LocalReport>();
  private queue: Promise<unknown> = Promise.resolve();
  private snapshot: OutboxSnapshot = { reports: [], loaded: false };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly disk: Disk, readonly root: string) {}

  // ---- lifecycle ---------------------------------------------------------------------------

  /** Reads every manifest. Directories without one are debris from a crash mid-delete: removed. */
  load(): Promise<void> {
    return this.serial(async () => {
      await this.disk.mkdir(this.root);
      this.reports.clear();
      for (const name of await this.disk.list(this.root)) {
        const dir = join(this.root, name);
        const manifest = join(dir, MANIFEST);
        if (!(await this.disk.exists(manifest))) {
          await this.disk.remove(dir);
          continue;
        }
        try {
          const stored = JSON.parse(await this.disk.readText(manifest)) as DiskReport;
          this.reports.set(stored.id, fromDisk(stored, dir));
        } catch {
          // A manifest we can't parse is a bug, not something to delete silently. Leave it on disk.
        }
      }
      this.publish(true);
    });
  }

  // ---- ReportStore (used by the engine) ----------------------------------------------------

  async listPending(): Promise<LocalReport[]> {
    await this.queue;
    return [...this.reports.values()]
      .filter(report => isPending(report.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  updateReport(id: string, patch: ReportPatch): Promise<void> {
    return this.serial(async () => {
      const report = this.reports.get(id);
      if (!report) return;
      const next = { ...report, ...patch };
      await this.persist(next);
      // The server has the photos now: free the space. The manifest stays as a receipt.
      if (patch.status === 'uploaded') {
        for (const image of next.images) await this.disk.remove(image.uri);
      }
    });
  }

  updateImage(id: string, patch: ImagePatch): Promise<void> {
    return this.serial(async () => {
      for (const report of this.reports.values()) {
        const index = report.images.findIndex(image => image.id === id);
        if (index === -1) continue;
        const images = report.images.map((image, i) => (i === index ? { ...image, ...patch } : image));
        await this.persist({ ...report, images });
        return;
      }
    });
  }

  recoverInterrupted(): Promise<number> {
    return this.serial(async () => {
      let count = 0;
      for (const report of [...this.reports.values()]) {
        if (report.status !== 'uploading' && report.status !== 'committing') continue;
        await this.persist({ ...report, status: 'queued', nextAttemptAt: null });
        count += 1;
      }
      return count;
    });
  }

  // ---- used by the app ---------------------------------------------------------------------

  /**
   * Adopt a fully-written staging directory as a queued report. The manifest is written
   * into the staging dir first, then the dir is renamed into the outbox: that rename is
   * the moment the report becomes durable.
   */
  adopt(stagingDir: string, report: LocalReport): Promise<void> {
    return this.serial(async () => {
      const dir = join(this.root, report.id);
      await this.disk.writeTextAtomic(join(stagingDir, MANIFEST), JSON.stringify(toDisk(report)));
      await this.disk.move(stagingDir, dir);
      this.reports.set(report.id, fromDisk(toDisk(report), dir));
      this.publish();
    });
  }

  /** User asked to try a failed report again: back of the queue's normal rules, fresh backoff. */
  retry(id: string): Promise<void> {
    return this.serial(async () => {
      const report = this.reports.get(id);
      if (!report || report.status !== 'failed') return;
      await this.persist({ ...report, status: 'queued', attempts: 0, nextAttemptAt: null, lastError: null });
    });
  }

  /** Remove one report and its photos from this phone. Only offered for failed or delivered reports. */
  discard(id: string): Promise<void> {
    return this.serial(async () => {
      const report = this.reports.get(id);
      if (!report) return;
      this.reports.delete(id);
      await this.disk.remove(join(this.root, id));
      this.publish();
    });
  }

  /** Forget delivery receipts. Doesn't touch anything still waiting to send. */
  clearDelivered(): Promise<void> {
    return this.serial(async () => {
      for (const report of [...this.reports.values()]) {
        if (report.status !== 'uploaded') continue;
        this.reports.delete(report.id);
        await this.disk.remove(join(this.root, report.id));
      }
      this.publish();
    });
  }

  /** Everything, gone. Caller must stop the engine first. */
  wipe(): Promise<void> {
    return this.serial(async () => {
      this.reports.clear();
      this.publish();
      await this.disk.remove(this.root);
      await this.disk.mkdir(this.root);
    });
  }

  get(id: string): LocalReport | undefined {
    const report = this.reports.get(id);
    return report && clone(report);
  }

  // ---- subscription (useSyncExternalStore-shaped) -----------------------------------------

  getSnapshot = (): OutboxSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // ---- internals ---------------------------------------------------------------------------

  private async persist(report: LocalReport): Promise<void> {
    const dir = join(this.root, report.id);
    await this.disk.writeTextAtomic(join(dir, MANIFEST), JSON.stringify(toDisk(report)));
    this.reports.set(report.id, report);
    this.publish();
  }

  private publish(loaded = this.snapshot.loaded): void {
    const reports = [...this.reports.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.snapshot = { reports, loaded };
    for (const listener of this.listeners) listener();
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }
}

const clone = (report: LocalReport): LocalReport => ({ ...report, images: report.images.map(image => ({ ...image })) });

const fileName = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

function toDisk(report: LocalReport): DiskReport {
  return { ...report, images: report.images.map(({ uri, ...image }) => ({ ...image, file: fileName(uri) })) };
}

function fromDisk(stored: DiskReport, dir: string): LocalReport {
  return { ...stored, images: stored.images.map(({ file, ...image }) => ({ ...image, uri: join(dir, file) })) };
}
