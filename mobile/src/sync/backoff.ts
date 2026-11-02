export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 2_000, maxMs: 5 * 60_000 };

/**
 * Exponential backoff with "equal jitter": half the window is guaranteed, half is random.
 * Guaranteed half stops us hammering a struggling server; random half stops a fleet of
 * phones that lost signal together from retrying in lockstep.
 *
 * attempt 1 → 1–2s, 2 → 2–4s, 3 → 4–8s, … capped at maxMs.
 */
export function backoffDelay(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const window = Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
  return Math.round(window / 2 + random() * (window / 2));
}
