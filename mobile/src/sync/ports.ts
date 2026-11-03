import type { LocalImage, LocalReport } from '../domain/report';

/**
 * Everything the upload engine needs from the outside world. The engine imports
 * nothing from React or React Native; production adapters live in src/platform,
 * src/api and src/outbox, wired together in src/app/runtime.ts.
 */

export type ReportPatch = Partial<
  Pick<LocalReport, 'status' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'uploadedAt'>
>;
export type ImagePatch = Partial<Pick<LocalImage, 'uploadedBytes' | 'uploaded'>>;

/** Durable outbox. Writes to rows that no longer exist (e.g. after a reset) must be silent no-ops. */
export interface ReportStore {
  /** queued / uploading / committing, oldest first. */
  listPending(): Promise<LocalReport[]>;
  updateReport(id: string, patch: ReportPatch): Promise<void>;
  updateImage(id: string, patch: ImagePatch): Promise<void>;
  /** Startup recovery: anything left mid-flight by a dead process goes back to `queued`. */
  recoverInterrupted(): Promise<number>;
}

export interface DeclareImageInput {
  imageId: string;
  reportId: string;
  size: number;
  sha256: string;
  mimeType: 'image/jpeg';
}

export interface UploadState {
  offset: number;
  complete: boolean;
}

export interface CommitInput {
  id: string;
  description: string;
  createdAt: string;
  images: { id: string; position: number }[];
}

export interface CommitResult {
  receivedAt: string;
  /** false when the server already had it (a retry after a lost response). */
  created: boolean;
}

/**
 * Must reject with `TransportError` (see errors.ts) so failures can be classified.
 * Must honour `signal`: abort means stop now, the result will be ignored.
 */
export interface UploadTransport {
  declareImage(input: DeclareImageInput, signal: AbortSignal): Promise<UploadState>;
  sendChunk(imageId: string, offset: number, bytes: Uint8Array, signal: AbortSignal): Promise<UploadState>;
  commitReport(input: CommitInput, signal: AbortSignal): Promise<CommitResult>;
}

export interface FileReader {
  /** Reads `length` bytes at `offset`. Rejects with `LocalFileError` if the file is gone. */
  read(uri: string, offset: number, length: number): Promise<Uint8Array>;
}

export interface Connectivity {
  /** false only when the OS is sure there is no network (airplane mode). Unknown counts as online. */
  isOffline(): Promise<boolean>;
}

export interface Clock {
  now(): number;
}

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}
