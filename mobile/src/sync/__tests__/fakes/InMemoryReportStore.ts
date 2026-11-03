import { isPending, type LocalReport } from '../../../domain/report';
import type { ImagePatch, ReportPatch, ReportStore } from '../../ports';

/** Reports are plain JSON, which is exactly what survives a trip through SQLite. */
const clone = (report: LocalReport): LocalReport => JSON.parse(JSON.stringify(report));

/** Thrown by a store whose "process" has been killed. */
export class ProcessKilled extends Error {}

/**
 * Stand-in for the SQLite outbox. `disk` survives a simulated force-quit: kill the
 * store after N writes, then `reopen()` a fresh one over the same disk, the way a new
 * process would find the database.
 */
export class InMemoryReportStore implements ReportStore {
  private writes = 0;
  private killAfter = Infinity;
  dead = false;

  constructor(readonly disk: Map<string, LocalReport> = new Map()) {}

  static with(reports: LocalReport[]): InMemoryReportStore {
    return new InMemoryReportStore(new Map(reports.map(report => [report.id, clone(report)])));
  }

  /** The (killAfter + 1)-th write throws, and so does everything after it. */
  killAfterWrites(count: number): this {
    this.killAfter = count;
    return this;
  }

  reopen(): InMemoryReportStore {
    return new InMemoryReportStore(this.disk);
  }

  get(id: string): LocalReport | undefined {
    const report = this.disk.get(id);
    return report && clone(report);
  }

  all(): LocalReport[] {
    return [...this.disk.values()].map(report => clone(report));
  }

  async listPending(): Promise<LocalReport[]> {
    this.assertAlive();
    return this.all()
      .filter(report => isPending(report.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateReport(id: string, patch: ReportPatch): Promise<void> {
    this.write();
    const report = this.disk.get(id);
    if (report) Object.assign(report, patch);
  }

  async updateImage(id: string, patch: ImagePatch): Promise<void> {
    this.write();
    for (const report of this.disk.values()) {
      const image = report.images.find(candidate => candidate.id === id);
      if (image) Object.assign(image, patch);
    }
  }

  async recoverInterrupted(): Promise<number> {
    this.write();
    let count = 0;
    for (const report of this.disk.values()) {
      if (report.status === 'uploading' || report.status === 'committing') {
        report.status = 'queued';
        report.nextAttemptAt = null;
        count += 1;
      }
    }
    return count;
  }

  private write(): void {
    this.assertAlive();
    this.writes += 1;
    if (this.writes > this.killAfter) {
      this.dead = true;
      throw new ProcessKilled(`killed at write ${this.writes}`);
    }
  }

  private assertAlive(): void {
    if (this.dead) throw new ProcessKilled('process is dead');
  }
}
