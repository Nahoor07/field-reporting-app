import type { LocalImage, LocalReport } from '../../../domain/report';
import { LocalFileError } from '../../errors';
import type { FileReader } from '../../ports';
import { sha256 } from './FakeServer';

/** Files on "disk", keyed by uri. */
export class MemoryFiles implements FileReader {
  readonly files = new Map<string, Uint8Array>();
  reads = 0;

  async read(uri: string, offset: number, length: number): Promise<Uint8Array> {
    this.reads += 1;
    const file = this.files.get(uri);
    if (!file) throw new LocalFileError(`missing ${uri}`);
    return file.slice(offset, offset + length);
  }
}

/** Deterministic PRNG so a failing chaos seed can be replayed. */
/* eslint-disable no-bitwise -- a PRNG is bit twiddling by definition */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* eslint-enable no-bitwise */

let counter = 0;

export function makeReport(
  files: MemoryFiles,
  options: { imageSizes?: number[]; createdAt?: string; random?: () => number; description?: string } = {},
): LocalReport {
  counter += 1;
  const id = `report-${String(counter).padStart(4, '0')}`;
  const random = options.random ?? Math.random;
  const images: LocalImage[] = (options.imageSizes ?? [3_000]).map((size, position) => {
    const bytes = new Uint8Array(size).map(() => Math.floor(random() * 256));
    const uri = `file:///outbox/${id}-${position}.jpg`;
    files.files.set(uri, bytes);
    return {
      id: `${id}-img-${position}`,
      reportId: id,
      position,
      uri,
      size,
      sha256: sha256(bytes),
      width: 2048,
      height: 1536,
      uploadedBytes: 0,
      uploaded: false,
    };
  });
  return {
    id,
    description: options.description ?? `Inspection ${counter}`,
    createdAt: options.createdAt ?? new Date(Date.UTC(2026, 10, 2, 9, 0, counter)).toISOString(),
    status: 'queued',
    images,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    uploadedAt: null,
  };
}
