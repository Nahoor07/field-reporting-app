import { backoffDelay } from '../backoff';
import { classify, LocalFileError, TransportError } from '../errors';

describe('classify', () => {
  const http = (status: number, error?: string) => new TransportError('http', String(status), status, { error });

  it.each([
    ['network drop', new TransportError('network', 'x'), true],
    ['timeout', new TransportError('timeout', 'x'), true],
    ['408', http(408), true],
    ['429', http(429), true],
    ['500', http(500), true],
    ['503', http(503), true],
    ['409 images_incomplete', http(409, 'images_incomplete'), true],
    ['400', http(400), false],
    ['409 upload_conflict', http(409, 'upload_conflict'), false],
    ['413', http(413), false],
    ['422', http(422), false],
    ['missing local file', new LocalFileError('x'), false],
    ['unexpected bug', new Error('boom'), true],
  ])('%s → retryable: %s', (_, error, retryable) => {
    expect(classify(error).retryable).toBe(retryable);
  });

  it('carries Retry-After through', () => {
    expect(classify(new TransportError('http', '429', 429, {}, 30_000)).retryAfterMs).toBe(30_000);
  });
});

describe('backoffDelay', () => {
  const policy = { baseMs: 2_000, maxMs: 300_000 };

  it('doubles the window each attempt, with at least half of it guaranteed', () => {
    expect(backoffDelay(1, policy, () => 0)).toBe(1_000);
    expect(backoffDelay(1, policy, () => 1)).toBe(2_000);
    expect(backoffDelay(4, policy, () => 0)).toBe(8_000);
    expect(backoffDelay(4, policy, () => 1)).toBe(16_000);
  });

  it('is capped', () => {
    expect(backoffDelay(50, policy, () => 1)).toBe(300_000);
  });
});
