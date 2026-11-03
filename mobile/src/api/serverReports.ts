import { request } from './http';

/** What the server holds. This is the only source for the "On the server" screen. */
export interface ServerReport {
  id: string;
  description: string;
  createdAt: string;
  receivedAt: string;
  images: { id: string; position: number; size: number; url: string }[];
}

export async function fetchServerReports(baseUrl: string, signal: AbortSignal): Promise<ServerReport[]> {
  const { body } = await request<{ reports: ServerReport[] }>({
    method: 'GET',
    url: `${baseUrl}/v1/reports`,
    headers: { Accept: 'application/json' },
    signal,
  });
  return [...body.reports].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}
