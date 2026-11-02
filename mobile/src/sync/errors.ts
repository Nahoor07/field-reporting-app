import type { FailureReason } from '../domain/report';

export interface ErrorBody {
  error?: string;
  message?: string;
  /** Server's real offset, sent with 409 offset_mismatch and 422 checksum_mismatch. */
  offset?: number;
  /** Image ids the server doesn't have complete, sent with 409 images_incomplete. */
  missing?: string[];
}

export type TransportErrorKind = 'network' | 'timeout' | 'http' | 'aborted';

export class TransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
    readonly status?: number,
    readonly body?: ErrorBody,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TransportError';
  }

  get code(): string | undefined {
    return this.body?.error;
  }
}

/** The processed image vanished from app storage. Can't be retried into existence. */
export class LocalFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalFileError';
  }
}

/** Defence in depth: refuse to send something that breaks the contract, even if compose let it through. */
export class ContractViolation extends Error {
  constructor(readonly reason: FailureReason, message: string) {
    super(message);
    this.name = 'ContractViolation';
  }
}

export interface Failure {
  reason: FailureReason;
  retryable: boolean;
  message: string;
  retryAfterMs?: number;
}

/**
 * The retry policy in one place. The rule: retry when trying again could plausibly
 * succeed without anyone changing anything (network, timeouts, overload); stop when
 * the server has told us, definitively, that this request is wrong.
 */
export function classify(error: unknown): Failure {
  if (error instanceof TransportError) {
    switch (error.kind) {
      case 'network':
        return { reason: 'network', retryable: true, message: 'No connection to the server' };
      case 'timeout':
        return { reason: 'timeout', retryable: true, message: 'The server stopped responding' };
      case 'aborted':
        return { reason: 'unknown', retryable: true, message: 'Upload was interrupted' };
      case 'http':
        return classifyStatus(error);
    }
  }
  if (error instanceof LocalFileError) {
    return { reason: 'file_missing', retryable: false, message: 'A photo is missing from this phone' };
  }
  if (error instanceof ContractViolation) {
    return { reason: error.reason, retryable: false, message: error.message };
  }
  // A bug, not the network. Keep the report and keep retrying slowly: losing work is worse.
  return { reason: 'unknown', retryable: true, message: error instanceof Error ? error.message : 'Unexpected error' };
}

function classifyStatus(error: TransportError): Failure {
  const status = error.status ?? 0;
  if (status === 408) return { reason: 'timeout', retryable: true, message: 'The server timed out' };
  if (status === 429) {
    return {
      reason: 'rate_limited',
      retryable: true,
      message: 'The server asked us to slow down',
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (status >= 500) {
    return {
      reason: 'server_error',
      retryable: true,
      message: `Server error (${status})`,
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (status === 409 && error.code === 'images_incomplete') {
    return { reason: 'server_error', retryable: true, message: 'Server is missing some photos; re-sending them' };
  }
  if (status === 413)
    return { reason: 'too_large', retryable: false, message: 'The server refused a photo as too large' };
  return {
    reason: 'rejected',
    retryable: false,
    message: error.body?.message
      ? `Server refused the report: ${error.body.message}`
      : `Server refused the report (${status})`,
  };
}
