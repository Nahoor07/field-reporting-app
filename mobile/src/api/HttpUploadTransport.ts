import type { CommitInput, CommitResult, DeclareImageInput, UploadState, UploadTransport } from '../sync/ports';
import { request } from './http';

/** The backend's resumable-upload protocol (see backend/src/app.ts). */
export class HttpUploadTransport implements UploadTransport {
  constructor(private readonly baseUrl: () => string) {}

  async declareImage(input: DeclareImageInput, signal: AbortSignal): Promise<UploadState> {
    const { body } = await request<UploadState>({
      method: 'POST',
      url: `${this.baseUrl()}/v1/uploads`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
    return body;
  }

  async sendChunk(imageId: string, offset: number, bytes: Uint8Array, signal: AbortSignal): Promise<UploadState> {
    const { body } = await request<UploadState>({
      method: 'PATCH',
      url: `${this.baseUrl()}/v1/uploads/${encodeURIComponent(imageId)}`,
      headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset) },
      body: bytes,
      signal,
    });
    return body;
  }

  async commitReport({ id, ...rest }: CommitInput, signal: AbortSignal): Promise<CommitResult> {
    const { body } = await request<{ report: { receivedAt: string }; created: boolean }>({
      method: 'PUT',
      url: `${this.baseUrl()}/v1/reports/${encodeURIComponent(id)}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rest),
      signal,
    });
    return { receivedAt: body.report.receivedAt, created: body.created };
  }
}
