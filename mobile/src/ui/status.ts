import { reportProgress, type LocalReport } from '../domain/report';
import type { EngineActivity } from '../sync/UploadEngine';

/**
 * Every word the app says about where work stands comes from here. Rules:
 *  - "Saved on this phone" and "On the server" are different facts and never share a sentence.
 *  - "On the server" is said only after the server confirmed the commit (status 'uploaded').
 *  - A waiting report always says what it is waiting for and when it will try again.
 */
export type Tone = 'safe' | 'moving' | 'waiting' | 'problem' | 'done';

export interface StatusView {
  tone: Tone;
  title: string;
  detail: string;
  /** 0–1 when bytes are moving. */
  progress?: number;
}

export function reportStatus(report: LocalReport, ctx: { offline: boolean; now: number }): StatusView {
  const { bytes, total, imagesDone } = reportProgress(report);
  const fraction = total > 0 ? bytes / total : 0;
  const photos = report.images.length;

  switch (report.status) {
    case 'uploaded':
      return { tone: 'done', title: 'On the server', detail: `Received ${clock(report.uploadedAt)}` };
    case 'failed':
      return {
        tone: 'problem',
        title: 'Not sent: needs your decision',
        detail: report.lastError?.message ?? 'The server refused this report',
      };
    case 'committing':
      return { tone: 'moving', title: 'Finishing', detail: 'All photos sent, confirming with the server', progress: 1 };
    case 'uploading':
      return {
        tone: 'moving',
        title: `Sending · ${Math.floor(fraction * 100)}%`,
        detail: `Photo ${Math.min(imagesDone + 1, photos)} of ${photos} · ${formatBytes(bytes)} of ${formatBytes(total)}`,
        progress: fraction,
      };
    case 'queued': {
      const partial = bytes > 0 ? ` · ${Math.floor(fraction * 100)}% sent so far` : '';
      if (ctx.offline) return { tone: 'safe', title: 'Saved on this phone', detail: `Waiting for signal${partial}` };
      if (report.lastError && report.nextAttemptAt && report.nextAttemptAt > ctx.now) {
        return {
          tone: 'waiting',
          title: 'Saved on this phone',
          detail: `${report.lastError.message} · next try in ${countdown(report.nextAttemptAt - ctx.now)}${partial}`,
        };
      }
      return { tone: 'safe', title: 'Saved on this phone', detail: `Waiting its turn to send${partial}` };
    }
  }
}

export interface Summary extends StatusView {
  pending: number;
  failed: number;
  delivered: number;
  /** Offer "Try now" when we're sitting out a backoff with signal available. */
  canRetryNow: boolean;
}

export function summarize(
  reports: LocalReport[],
  ctx: { offline: boolean; activity: EngineActivity; now: number },
): Summary {
  const pending = reports.filter(r => r.status !== 'uploaded' && r.status !== 'failed');
  const failed = reports.filter(r => r.status === 'failed').length;
  const delivered = reports.filter(r => r.status === 'uploaded').length;
  const counts = { pending: pending.length, failed, delivered, canRetryNow: false };
  const n = pending.length;
  const reportsWord = plural(n, 'report');

  if (n === 0) {
    if (failed > 0)
      return { ...counts, tone: 'problem', title: `${plural(failed, 'report')} not sent`, detail: 'Each one needs your decision below.' };
    if (delivered > 0)
      return { ...counts, tone: 'done', title: 'Everything you sent is on the server', detail: 'Nothing waiting on this phone.' };
    return { ...counts, tone: 'done', title: 'Nothing waiting to send', detail: 'New reports appear here until the server has them.' };
  }

  let bytes = 0;
  let total = 0;
  for (const report of pending) {
    const p = reportProgress(report);
    bytes += p.bytes;
    total += p.total;
  }
  const sent = `${formatBytes(bytes)} of ${formatBytes(total)} sent`;

  if (ctx.offline) {
    return {
      ...counts,
      tone: 'safe',
      title: `No signal · ${reportsWord} saved on this phone`,
      detail: 'They send by themselves when signal returns. You can close the app.',
    };
  }
  if (ctx.activity.state === 'uploading') {
    return { ...counts, tone: 'moving', title: `Sending ${reportsWord}`, detail: sent, progress: total ? bytes / total : 0 };
  }
  if (ctx.activity.state === 'waiting' && ctx.activity.nextAttemptAt > ctx.now) {
    return {
      ...counts,
      tone: 'waiting',
      title: `${reportsWord} saved on this phone`,
      detail: `Server not reachable right now · next try in ${countdown(ctx.activity.nextAttemptAt - ctx.now)}`,
      canRetryNow: true,
    };
  }
  return { ...counts, tone: 'safe', title: `${reportsWord} saved on this phone`, detail: `Sending shortly · ${sent}` };
}

// ---- formatting --------------------------------------------------------------------------

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function clock(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay ? time : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}
