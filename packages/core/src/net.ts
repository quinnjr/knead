/** IP address parsing and Redis URL checks shared by the HTTP, rate-limit, GraphQL and schedule packages. */

function parseV4(ip: string): Uint8Array | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  const bytes = m.slice(1).map(Number);
  return bytes.every((b) => b <= 255) ? Uint8Array.from(bytes) : undefined;
}

function parseV6(input: string): Uint8Array | undefined {
  let ip = input.split('%')[0]!;
  const lastColon = ip.lastIndexOf(':');
  if (lastColon !== -1 && ip.slice(lastColon + 1).includes('.')) {
    const v4 = parseV4(ip.slice(lastColon + 1));
    if (!v4) return undefined;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [
    ...head,
    ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'),
    ...tail,
  ];
  const bytes = new Uint8Array(16);
  for (const [i, group] of groups.entries()) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    const n = Number.parseInt(group, 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

const MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

/** 4 bytes for IPv4 (including IPv4-mapped IPv6), 16 bytes for IPv6, undefined if invalid. */
export function parseIp(ip: string): Uint8Array | undefined {
  const v4 = parseV4(ip);
  if (v4) return v4;
  const v6 = parseV6(ip);
  if (!v6) return undefined;
  return MAPPED_PREFIX.every((b, i) => v6[i] === b) ? v6.slice(12) : v6;
}

/** Whether a URL hostname is loopback: `localhost`, `localhost.`, 127.0.0.0/8 or ::1 (also mapped). */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (host === 'localhost' || host === 'localhost.') return true;
  const bytes = parseIp(host);
  if (bytes?.length === 4) return bytes[0] === 127;
  return bytes?.every((b, i) => b === (i === 15 ? 1 : 0)) === true;
}

/**
 * The `host[:port]` of a plaintext Redis/Valkey URL (`redis://`, `valkey://`) to a host that is
 * not loopback, or undefined: TLS URLs (`rediss://`, `valkeys://`), Unix sockets, loopback hosts
 * unparseable URLs and URLs with no host are not plaintext remote connections.
 */
export function plaintextRedisHost(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'valkey:') return undefined;
  if (parsed.hostname === '') return undefined;
  return isLoopbackHostname(parsed.hostname) ? undefined : parsed.host;
}

/**
 * The URL Bun.redis connects to without an explicit one: REDIS_URL, else VALKEY_URL (an empty
 * value counts as unset), else `undefined`, in which case Bun connects to localhost.
 */
export function defaultRedisUrl(): string | undefined {
  return process.env.REDIS_URL || process.env.VALKEY_URL || undefined;
}
