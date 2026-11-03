const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(256);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

/* eslint-disable no-bitwise -- base64 is bit packing */
export function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  const length = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(length);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)];
    const b = LOOKUP[clean.charCodeAt(i + 1)];
    const c = LOOKUP[clean.charCodeAt(i + 2)];
    const d = LOOKUP[clean.charCodeAt(i + 3)];
    if (o < length) out[o++] = (a << 2) | (b >> 4);
    if (o < length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (o < length) out[o++] = ((c & 3) << 6) | d;
  }
  return out;
}
/* eslint-enable no-bitwise */
