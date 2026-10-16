import { formatIp, parseIp } from '@hpmws/http';

/** SHA-256 of a store key, as the first 32 hex characters (128 bits). */
export function hashKey(key: string): string {
  return new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 32);
}

/**
 * The rate-limit key for a client address: IPv4 as is, IPv6 masked to `prefix` bits and written
 * as `network/prefix` (one IPv6 client usually controls a whole /64). Unparseable input is
 * returned unchanged.
 */
export function maskIp(ip: string, prefix: number): string {
  const bytes = parseIp(ip);
  if (!bytes || bytes.length === 4) return ip;
  const masked = Uint8Array.from(bytes);
  for (let bit = prefix; bit < 128; bit++) masked[bit >> 3]! &= ~(0x80 >> (bit & 7));
  return `${formatIp(masked)}/${prefix}`;
}
