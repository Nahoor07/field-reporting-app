import { TransportError, type ErrorBody } from '../sync/errors';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal: AbortSignal;
}

export interface HttpResponse<T> {
  status: number;
  body: T;
}

/**
 * One request over XMLHttpRequest, failures translated into the engine's vocabulary:
 * no response at all → 'network', caller aborted → 'aborted', any status ≥ 400 → 'http'.
 *
 * XHR rather than fetch: abort semantics are exact and status-0 failures are distinguishable.
 * Deadlines are the caller's job (the engine races every call against its own timer).
 */
export function request<T>({ method, url, headers = {}, body, signal }: HttpRequest): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new TransportError('aborted', 'Aborted before sending'));
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort);
    const done = () => signal.removeEventListener('abort', onAbort);

    xhr.open(method, url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.responseType = 'text';

    xhr.onload = () => {
      done();
      const parsed = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) return resolve({ status: xhr.status, body: parsed as T });
      reject(
        new TransportError(
          'http',
          `HTTP ${xhr.status}`,
          xhr.status,
          (parsed ?? undefined) as ErrorBody | undefined,
          retryAfterMs(xhr.getResponseHeader('retry-after')),
        ),
      );
    };
    xhr.onerror = () => {
      done();
      reject(new TransportError('network', 'Connection failed'));
    };
    xhr.onabort = () => {
      done();
      reject(new TransportError('aborted', 'Request aborted'));
    };
    xhr.ontimeout = () => {
      done();
      reject(new TransportError('timeout', 'Request timed out'));
    };
    // RN's XHR sends typed arrays natively (as base64 over the bridge), no Blob needed.
    xhr.send((body ?? null) as never);
  });
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Retry-After as seconds or an HTTP date. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
