import 'react-native-get-random-values';

/** Installed by react-native-get-random-values (backed by the OS CSPRNG). */
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };

/**
 * RFC 4122 v4 UUID from the OS CSPRNG. These ids are idempotency keys: the server dedupes
 * on them, so they must be generated once, on the device, before the first attempt.
 */
export function uuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  /* eslint-disable no-bitwise */
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  /* eslint-enable no-bitwise */
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
