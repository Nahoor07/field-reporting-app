/**
 * A report's life on the device. Only `uploaded` means the server has it.
 *
 *   queued ──▶ uploading ──▶ committing ──▶ uploaded
 *     ▲            │              │
 *     └── retry ◀──┴──────────────┘ (transient failure, backoff)
 *                  └──────────────┴──▶ failed (permanent; user decides)
 *
 * `uploading` / `committing` found at startup mean the app died mid-flight;
 * they are reset to `queued` and resumed from the server's offsets.
 */
export type ReportStatus = 'queued' | 'uploading' | 'committing' | 'uploaded' | 'failed';

export type FailureReason =
  | 'network'
  | 'timeout'
  | 'server_error'
  | 'rate_limited'
  | 'rejected'
  | 'too_large'
  | 'file_missing'
  | 'unknown';

export interface ReportError {
  reason: FailureReason;
  message: string;
  retryable: boolean;
  /** ISO timestamp of the failure. */
  at: string;
}

export interface LocalImage {
  id: string;
  reportId: string;
  /** 0-based order within the report. */
  position: number;
  /** Processed (resized/compressed) JPEG in app-owned storage. */
  uri: string;
  size: number;
  sha256: string;
  width: number;
  height: number;
  /** Last offset the server acknowledged. Progress only; the server is the truth on resume. */
  uploadedBytes: number;
  uploaded: boolean;
}

export interface LocalReport {
  id: string;
  description: string;
  /** ISO timestamp of when the user submitted it. */
  createdAt: string;
  status: ReportStatus;
  images: LocalImage[];
  /** Consecutive failed attempts without progress; drives backoff. */
  attempts: number;
  /** Epoch ms before which the engine won't retry. null = as soon as possible. */
  nextAttemptAt: number | null;
  lastError: ReportError | null;
  /** Server's receipt time, set only once the server confirmed the commit. */
  uploadedAt: string | null;
}

export const isPending = (status: ReportStatus) => status !== 'uploaded' && status !== 'failed';

export function reportProgress(report: LocalReport): { bytes: number; total: number; imagesDone: number } {
  let bytes = 0;
  let total = 0;
  let imagesDone = 0;
  for (const image of report.images) {
    total += image.size;
    bytes += image.uploaded ? image.size : Math.min(image.uploadedBytes, image.size);
    if (image.uploaded) imagesDone += 1;
  }
  return { bytes, total, imagesDone };
}
