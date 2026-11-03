/// <reference types="node" />
// Tests run in Node; the app computes hashes natively (see src/platform).
import { createHash } from 'crypto';
import { MAX_IMAGE_BYTES } from '../../../domain/limits';
import { TransportError } from '../../errors';
import type { CommitInput, CommitResult, DeclareImageInput, UploadState, UploadTransport } from '../../ports';

export type Op = 'declare' | 'chunk' | 'commit';
export type FaultKind = 'drop' | 'lose-response' | 'hang' | { status: number; code?: string };

interface ScriptedFault {
  op: Op;
  kind: FaultKind;
  times: number;
  /** Let this many matching calls through first. */
  skip: number;
}

interface Upload {
  reportId: string;
  size: number;
  sha256: string;
  data: Uint8Array;
  received: number;
  complete: boolean;
}

export interface StoredReport {
  id: string;
  description: string;
  imageIds: string[];
  receivedAt: string;
}

const CHAOS_KINDS: FaultKind[] = ['drop', 'lose-response', 'hang', { status: 503 }, { status: 500 }, { status: 429 }];

/**
 * In-memory twin of backend/src/app.ts: same protocol, same idempotency rules,
 * plus the same fault vocabulary. Scripted faults fire in order; chaos mode fires
 * a random fault on a fraction of calls.
 */
export class FakeServer implements UploadTransport {
  readonly uploads = new Map<string, Upload>();
  readonly reports = new Map<string, StoredReport>();
  bytesReceived = 0;
  calls: Record<Op, number> = { declare: 0, chunk: 0, commit: 0 };
  private scripted: ScriptedFault[] = [];
  private chaos: { probability: number; random: () => number } | null = null;

  fail(op: Op, kind: FaultKind, times = 1, { skip = 0 } = {}): this {
    this.scripted.push({ op, kind, times, skip });
    return this;
  }

  enableChaos(probability: number, random: () => number): this {
    this.chaos = { probability, random };
    return this;
  }

  disableChaos(): this {
    this.chaos = null;
    return this;
  }

  /** Simulates the server losing an image (e.g. a wipe) after the client thought it was done. */
  forget(imageId: string): void {
    this.uploads.delete(imageId);
  }

  imageBytes(imageId: string): Uint8Array | undefined {
    const upload = this.uploads.get(imageId);
    return upload?.complete ? upload.data : undefined;
  }

  declareImage(input: DeclareImageInput, signal: AbortSignal): Promise<UploadState> {
    return this.handle('declare', signal, () => {
      if (input.size > MAX_IMAGE_BYTES) throw http(413, 'image_too_large');
      const existing = this.uploads.get(input.imageId);
      if (existing) {
        if (existing.sha256 !== input.sha256 || existing.reportId !== input.reportId)
          throw http(409, 'upload_conflict');
        return { offset: existing.complete ? existing.size : existing.received, complete: existing.complete };
      }
      this.uploads.set(input.imageId, {
        reportId: input.reportId,
        size: input.size,
        sha256: input.sha256,
        data: new Uint8Array(input.size),
        received: 0,
        complete: false,
      });
      return { offset: 0, complete: false };
    });
  }

  sendChunk(imageId: string, offset: number, bytes: Uint8Array, signal: AbortSignal): Promise<UploadState> {
    return this.handle('chunk', signal, () => {
      const upload = this.uploads.get(imageId);
      if (!upload) throw http(404, 'upload_not_found');
      if (upload.complete) return { offset: upload.size, complete: true };
      if (offset !== upload.received) throw http(409, 'offset_mismatch', { offset: upload.received });
      if (offset + bytes.length > upload.size) throw http(400, 'chunk_overflow');
      upload.data.set(bytes, offset);
      upload.received += bytes.length;
      this.bytesReceived += bytes.length;
      if (upload.received < upload.size) return { offset: upload.received, complete: false };
      if (sha256(upload.data) !== upload.sha256) {
        upload.received = 0;
        throw http(422, 'checksum_mismatch', { offset: 0 });
      }
      upload.complete = true;
      return { offset: upload.size, complete: true };
    });
  }

  commitReport(input: CommitInput, signal: AbortSignal): Promise<CommitResult> {
    return this.handle('commit', signal, () => {
      const existing = this.reports.get(input.id);
      if (existing) return { receivedAt: existing.receivedAt, created: false };
      const missing = input.images.filter(image => !this.uploads.get(image.id)?.complete).map(image => image.id);
      if (missing.length > 0) throw http(409, 'images_incomplete', { missing });
      const stored = {
        id: input.id,
        description: input.description,
        imageIds: input.images.map(image => image.id),
        receivedAt: new Date().toISOString(),
      };
      this.reports.set(input.id, stored);
      return { receivedAt: stored.receivedAt, created: true };
    });
  }

  private async handle<T>(op: Op, signal: AbortSignal, apply: () => T): Promise<T> {
    this.calls[op] += 1;
    await Promise.resolve(); // never complete synchronously, like a real network
    const fault = this.nextFault(op);
    if (fault === 'drop') throw new TransportError('network', 'connection dropped');
    if (fault === 'hang') return hang(signal);
    if (fault && typeof fault === 'object') throw http(fault.status, fault.code ?? 'injected_fault');
    const result = apply();
    if (fault === 'lose-response') throw new TransportError('network', 'connection dropped after the server acted');
    return result;
  }

  private nextFault(op: Op): FaultKind | null {
    const index = this.scripted.findIndex(fault => fault.op === op);
    if (index !== -1) {
      const fault = this.scripted[index]!;
      if (fault.skip > 0) {
        fault.skip -= 1;
        return null;
      }
      fault.times -= 1;
      if (fault.times <= 0) this.scripted.splice(index, 1);
      return fault.kind;
    }
    if (this.chaos && this.chaos.random() < this.chaos.probability) {
      return CHAOS_KINDS[Math.floor(this.chaos.random() * CHAOS_KINDS.length)]!;
    }
    return null;
  }
}

function http(status: number, code: string, extra: { offset?: number; missing?: string[] } = {}): TransportError {
  return new TransportError('http', `${status} ${code}`, status, { error: code, ...extra });
}

function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new TransportError('aborted', 'aborted')));
  });
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
