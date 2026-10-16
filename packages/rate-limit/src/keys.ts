/** SHA-256 of a store key, as the first 32 hex characters (128 bits). */
export function hashKey(key: string): string {
  return new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 32);
}

/** The rate-limit key for a client address: `@hpmws/http`'s maskIp (IPv6 grouped by prefix). */
export { maskIp } from '@hpmws/http';
