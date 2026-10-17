/**
 * A store key's digest, as the first 32 hex characters (128 bits): HMAC-SHA256 under `secret`
 * when one is given, otherwise plain SHA-256. A plain hash does not hide low-entropy keys: every
 * IPv4 address can be hashed in seconds, so an unkeyed hash of an IP is recoverable.
 */
export function hashKey(key: string, secret?: string | Uint8Array): string {
  const digest =
    secret === undefined
      ? new Bun.CryptoHasher('sha256').update(key).digest('hex')
      : new Bun.CryptoHasher('sha256', secret).update(key).digest('hex');
  return digest.slice(0, 32);
}

/** A copy of `secret` as bytes, or a RangeError unless it has at least 32 bytes. */
export function hashSecretBytes(secret: string | Uint8Array): Uint8Array {
  const bytes =
    typeof secret === 'string' ? new TextEncoder().encode(secret) : Uint8Array.from(secret);
  if (bytes.byteLength < 32) throw new RangeError('hashSecret must be at least 32 bytes.');
  return bytes;
}

/** The rate-limit key for a client address: `@knead-js/http`'s maskIp (IPv6 grouped by prefix). */
export { maskIp } from '@knead-js/http';
