import { composeProblems, remainingSlots, type DraftPhoto } from '../domain/compose';
import type { LocalReport } from '../domain/report';
import { join, type Disk } from '../platform/disk';
import type { FileOutboxStore } from '../outbox/FileOutboxStore';

/**
 * The one report being composed. Persisted, because a force-quit while writing a
 * description in a stairwell is also "losing work".
 *
 *   <root>/draft.json        description + processed photos
 *   <root>/<photoId>.jpg     processed photos (same format the outbox wants)
 *
 * Submitting turns this directory into an outbox entry by rename, so photos are never
 * copied and a submit is atomic.
 */
export interface PreparingSlot {
  id: string;
  /** Local preview of the original, shown while the processed version is made. */
  previewUri: string;
}

export interface DraftSnapshot {
  description: string;
  photos: DraftPhoto[];
  preparing: PreparingSlot[];
  /** Last photo that couldn't be prepared, for one inline message. */
  lastError: string | null;
  loaded: boolean;
}

export interface DraftDeps {
  disk: Disk;
  outbox: FileOutboxStore;
  /** Resizes/compresses `sourceUri` into `<destDir>/<id>.jpg`. */
  processPhoto(sourceUri: string, id: string, destDir: string): Promise<DraftPhoto>;
  /** Removes the picker's temporary copy. */
  removeSource(sourceUri: string): Promise<void>;
  newId(): string;
  now(): Date;
}

const DRAFT_FILE = 'draft.json';
const DESCRIPTION_SAVE_DELAY_MS = 400;

export class DraftStore {
  private snapshot: DraftSnapshot = { description: '', photos: [], preparing: [], lastError: null, loaded: false };
  private readonly listeners = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private processing: Promise<unknown> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by submit/discard/wipe so in-flight photo processing knows its draft is gone. */
  private epoch = 0;

  constructor(private readonly deps: DraftDeps, readonly root: string) {}

  async load(): Promise<void> {
    const { disk } = this.deps;
    await disk.mkdir(this.root);
    let description = '';
    let photos: DraftPhoto[] = [];
    try {
      const saved = JSON.parse(await disk.readText(join(this.root, DRAFT_FILE))) as {
        description: string;
        photos: (Omit<DraftPhoto, 'path'> & { file: string })[];
      };
      description = saved.description;
      // Keep only photos whose file actually survived.
      for (const { file, ...photo } of saved.photos) {
        const path = join(this.root, file);
        if (await disk.exists(path)) photos.push({ ...photo, path });
      }
    } catch {
      // No draft yet, or an unreadable one: start empty.
    }
    // Processed files that never made it into draft.json (killed between encode and save).
    const known = new Set(photos.map(photo => `${photo.id}.jpg`));
    for (const name of await disk.list(this.root)) {
      if (name.endsWith('.jpg') && !known.has(name)) await disk.remove(join(this.root, name));
    }
    this.set({ description, photos, preparing: [], lastError: null, loaded: true });
  }

  getSnapshot = (): DraftSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setDescription(description: string): void {
    this.set({ ...this.snapshot, description });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, DESCRIPTION_SAVE_DELAY_MS);
  }

  /** Write any pending description now (app going to background). */
  flush(): Promise<unknown> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
    return this.writes;
  }

  /**
   * Queue photos for processing. Returns how many were accepted; extras beyond the
   * 5-photo limit are dropped (and their temp copies deleted) rather than silently kept.
   */
  addPhotos(sourceUris: string[]): number {
    const room = remainingSlots(this.snapshot.photos.length, this.snapshot.preparing.length);
    const accepted = sourceUris.slice(0, room);
    for (const extra of sourceUris.slice(room)) this.deps.removeSource(extra).catch(() => {});
    const slots = accepted.map(uri => ({ id: this.deps.newId(), previewUri: uri }));
    this.set({ ...this.snapshot, preparing: [...this.snapshot.preparing, ...slots], lastError: null });

    const epoch = this.epoch;
    for (const slot of slots) {
      // One at a time: decoding several 50 MP originals at once is how phones run out of memory.
      this.processing = this.processing.then(() => this.processOne(slot, epoch));
    }
    return accepted.length;
  }

  removePhoto(id: string): void {
    const photo = this.snapshot.photos.find(candidate => candidate.id === id);
    if (!photo) return;
    this.set({ ...this.snapshot, photos: this.snapshot.photos.filter(candidate => candidate.id !== id) });
    this.save().then(() => this.deps.disk.remove(photo.path));
  }

  movePhoto(id: string, delta: -1 | 1): void {
    const photos = [...this.snapshot.photos];
    const from = photos.findIndex(photo => photo.id === id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= photos.length) return;
    [photos[from], photos[to]] = [photos[to], photos[from]];
    this.set({ ...this.snapshot, photos });
    this.save();
  }

  /**
   * Hand the draft to the outbox. Local-only: never waits on the network.
   * Throws if the draft isn't valid; the UI disables the button before that can happen.
   */
  async submit(): Promise<LocalReport> {
    await this.flush();
    const { description, photos, preparing } = this.snapshot;
    const problems = composeProblems({ description, photos, preparing: preparing.length });
    if (problems.length > 0) throw new Error(`Draft not ready: ${problems.map(p => p.kind).join(', ')}`);

    const reportId = this.deps.newId();
    const report: LocalReport = {
      id: reportId,
      description: description.trim(),
      createdAt: this.deps.now().toISOString(),
      status: 'queued',
      images: photos.map((photo, position) => ({
        id: photo.id,
        reportId,
        position,
        uri: photo.path,
        size: photo.size,
        sha256: photo.sha256,
        width: photo.width,
        height: photo.height,
        uploadedBytes: 0,
        uploaded: false,
      })),
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      uploadedAt: null,
    };

    this.epoch += 1;
    await this.writes;
    await this.deps.outbox.adopt(this.root, report);
    // The draft directory is now the report's directory. Start a fresh one.
    await this.deps.disk.remove(join(this.deps.outbox.root, reportId, DRAFT_FILE)).catch(() => {});
    await this.deps.disk.mkdir(this.root);
    this.set({ description: '', photos: [], preparing: [], lastError: null, loaded: true });
    return report;
  }

  async discard(): Promise<void> {
    this.epoch += 1;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.writes;
    this.set({ description: '', photos: [], preparing: [], lastError: null, loaded: true });
    await this.deps.disk.remove(this.root);
    await this.deps.disk.mkdir(this.root);
  }

  // ---- internals ---------------------------------------------------------------------------

  private async processOne(slot: PreparingSlot, epoch: number): Promise<void> {
    let photo: DraftPhoto | null = null;
    let error: string | null = null;
    try {
      photo = await this.deps.processPhoto(slot.previewUri, slot.id, this.root);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Couldn't prepare this photo";
    } finally {
      this.deps.removeSource(slot.previewUri).catch(() => {});
    }

    if (epoch !== this.epoch) {
      // The draft was submitted or discarded meanwhile; this file belongs to nobody.
      if (photo) await this.deps.disk.remove(photo.path).catch(() => {});
      return;
    }
    const preparing = this.snapshot.preparing.filter(candidate => candidate.id !== slot.id);
    const photos = photo ? [...this.snapshot.photos, photo] : this.snapshot.photos;
    this.set({ ...this.snapshot, photos, preparing, lastError: error ?? this.snapshot.lastError });
    if (photo) await this.save();
  }

  private save(): Promise<unknown> {
    const { description, photos } = this.snapshot;
    const body = JSON.stringify({
      description,
      photos: photos.map(({ path, ...photo }) => ({ ...photo, file: path.slice(path.lastIndexOf('/') + 1) })),
    });
    const target = join(this.root, DRAFT_FILE);
    this.writes = this.writes.then(() => this.deps.disk.writeTextAtomic(target, body)).catch(() => {});
    return this.writes;
  }

  private set(snapshot: DraftSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
