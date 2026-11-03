import { MAX_IMAGE_BYTES } from '../domain/limits';

/**
 * Turning a camera original (often 8–20 MB, 12–50 MP) into something that crosses 2G and is
 * still worth looking at.
 *
 * Every rung is a full native decode → resize → JPEG encode, off the JS thread. We take the
 * first rung that fits the *budget*. The budget is not the 5 MB ceiling: on 2G (~5–15 KB/s)
 * every megabyte is minutes, and 2048 px at q80 already resolves a hairline crack at arm's
 * length. The 5 MB ceiling is the hard stop the last line enforces, never the target.
 */
export interface Rung {
  /** Longest edge in px. Never upscales. */
  maxEdge: number;
  /** JPEG quality 0–100. */
  quality: number;
}

export const LADDER: readonly Rung[] = [
  { maxEdge: 2048, quality: 82 },
  { maxEdge: 2048, quality: 70 },
  { maxEdge: 1600, quality: 70 },
  { maxEdge: 1280, quality: 60 },
];

/** Soft target per photo. A typical 2048 px scene lands at 0.5–1.2 MB. */
export const BYTE_BUDGET = 1.5 * 1024 * 1024;

export interface Encoded {
  path: string;
  size: number;
  width: number;
  height: number;
}

export interface PrepareDeps {
  encode(source: string, rung: Rung): Promise<Encoded>;
  remove(path: string): Promise<void>;
}

export class ImageTooLargeError extends Error {
  constructor(readonly smallest: number) {
    super(`Couldn't get this photo under 5 MB (smallest attempt: ${(smallest / 1048576).toFixed(1)} MB)`);
    this.name = 'ImageTooLargeError';
  }
}

export async function prepareImage(
  source: string,
  deps: PrepareDeps,
  options: { ladder?: readonly Rung[]; budget?: number; ceiling?: number } = {},
): Promise<Encoded & { rung: Rung }> {
  const ladder = options.ladder ?? LADDER;
  const budget = options.budget ?? BYTE_BUDGET;
  const ceiling = options.ceiling ?? MAX_IMAGE_BYTES;

  let best: (Encoded & { rung: Rung }) | null = null;
  for (const rung of ladder) {
    const encoded = await deps.encode(source, rung);
    if (best === null || encoded.size < best.size) {
      if (best) await deps.remove(best.path);
      best = { ...encoded, rung };
    } else {
      await deps.remove(encoded.path);
    }
    if (best.size <= budget) break;
  }
  if (!best) throw new Error('Empty ladder');
  if (best.size > ceiling) {
    await deps.remove(best.path);
    throw new ImageTooLargeError(best.size);
  }
  return best;
}
