import { HttpConfigError } from './exceptions.js';

/** `false`: ignore forwarding headers. `number`: trust that many proxy hops. `string[]`: trusted CIDRs. */
export type TrustProxy = false | number | readonly string[];

export type CompiledTrust =
  | { kind: 'none' }
  | { kind: 'hops'; hops: number }
  | { kind: 'cidr'; isTrusted: (ip: string) => boolean };

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

/** Dotted IPv4 for 4 bytes; RFC 5952 IPv6 (lowercase, longest zero run compressed) for 16. */
export function formatIp(bytes: Uint8Array): string {
  if (bytes.length === 4) return bytes.join('.');
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i]! << 8) | bytes[i + 1]!);
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

/**
 * Canonical text form of an address, from its parsed bytes: IPv4-mapped IPv6 (dotted or hex)
 * becomes IPv4, IPv6 is lowercased and compressed, zone ids are dropped. Unparseable input is
 * returned unchanged.
 */
export function normalizeIp(ip: string): string {
  const bytes = parseIp(ip);
  return bytes ? formatIp(bytes) : ip;
}

export function cidrMatcher(list: readonly string[]): (ip: string) => boolean {
  const ranges = list.map((entry) => {
    const [address, bits] = entry.split('/');
    const bytes = parseIp(address ?? '');
    if (!bytes) throw new HttpConfigError(`Invalid trustProxy entry: ${entry}`);
    // An IPv4-mapped entry (`::ffff:10.0.0.0/104`) parses to IPv4 bytes; its prefix counts the
    // 96 bits of the mapped prefix, so it becomes an IPv4 /(prefix - 96).
    const mapped = bytes.length === 4 && address!.includes(':');
    const width = mapped ? 128 : bytes.length * 8;
    const written = bits === undefined ? width : Number(bits);
    const prefix = mapped ? written - 96 : written;
    if (!Number.isInteger(written) || written > width || prefix < 0) {
      throw new HttpConfigError(`Invalid trustProxy entry: ${entry}`);
    }
    return { bytes, prefix };
  });
  return (ip) => {
    const target = parseIp(ip);
    if (!target) return false;
    return ranges.some(({ bytes, prefix }) => {
      if (bytes.length !== target.length) return false;
      const full = prefix >> 3;
      const rest = prefix & 7;
      for (let i = 0; i < full; i++) if (bytes[i] !== target[i]) return false;
      if (rest === 0) return true;
      const mask = (0xff << (8 - rest)) & 0xff;
      return (bytes[full]! & mask) === (target[full]! & mask);
    });
  };
}

export function compileTrust(trust: TrustProxy): CompiledTrust {
  if (trust === false) return { kind: 'none' };
  if (typeof trust === 'number') {
    if (!Number.isInteger(trust) || trust < 0) {
      throw new HttpConfigError(
        `trustProxy hop count must be a non-negative integer, got ${trust}`,
      );
    }
    return trust === 0 ? { kind: 'none' } : { kind: 'hops', hops: trust };
  }
  return { kind: 'cidr', isTrusted: cidrMatcher(trust) };
}

function splitList(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .reverse();
}

/** Nearest valid IP at or to the right of `index` (towards the socket peer); the peer itself is the last resort. */
function validAtOrBefore(chain: readonly string[], index: number): string {
  for (let i = index; i > 0; i--) if (parseIp(chain[i]!)) return chain[i]!;
  return chain[0]!;
}

export function resolveClientIp(
  remote: string | undefined,
  forwardedFor: string | null,
  trust: CompiledTrust,
): string | undefined {
  if (remote === undefined) return undefined;
  if (trust.kind === 'none' || !forwardedFor) return normalizeIp(remote);
  const chain = [remote, ...splitList(forwardedFor)];
  // Hop-count mode: the peer is trusted by definition (the operator declared N proxies in front).
  // A header with fewer entries than hops did not pass through every proxy: ignore it.
  if (trust.kind === 'hops') {
    if (chain.length - 1 < trust.hops) return normalizeIp(remote);
    return normalizeIp(validAtOrBefore(chain, trust.hops));
  }
  let selected = chain.length - 1;
  for (const [i, address] of chain.entries()) {
    if (!trust.isTrusted(address)) {
      selected = i;
      break;
    }
  }
  return normalizeIp(validAtOrBefore(chain, selected));
}

export function resolveSecure(
  tls: boolean,
  remote: string | undefined,
  forwardedFor: string | null,
  forwardedProto: string | null,
  trust: CompiledTrust,
): boolean {
  if (tls) return true;
  if (remote === undefined || !forwardedProto || trust.kind === 'none') return false;
  const protos = splitList(forwardedProto);
  let index: number;
  if (trust.kind === 'hops') {
    // Hop-count mode: the peer is trusted by definition. Fewer entries than hops: ignore the header.
    if (protos.length < trust.hops) return false;
    index = trust.hops - 1;
  } else {
    if (!trust.isTrusted(remote)) return false;
    const chain = [remote, ...splitList(forwardedFor)];
    let trusted = 0;
    while (trusted < chain.length && trust.isTrusted(chain[trusted]!)) trusted++;
    index = trusted - 1;
  }
  // Index 0 is the value appended by the nearest proxy; the left-most values are client-controlled.
  if (protos.length === 0) return false;
  return protos[Math.min(index, protos.length - 1)]!.toLowerCase() === 'https';
}

/** Whether `prefix` is a valid IPv6 prefix length: an integer from 0 to 128. */
export function isIpv6Prefix(prefix: unknown): prefix is number {
  return typeof prefix === 'number' && Number.isInteger(prefix) && prefix >= 0 && prefix <= 128;
}

/**
 * A client address as a per-client key: IPv4 (including IPv4-mapped IPv6, returned in its IPv4
 * form) as is, IPv6 masked to `prefix` bits and written as `network/prefix` (one IPv6 client
 * usually controls a whole /64). The prefix applies to IPv6 only. Unparseable input is returned
 * unchanged. Throws a RangeError unless `prefix` is an integer from 0 to 128.
 */
export function maskIp(ip: string, prefix: number): string {
  if (!isIpv6Prefix(prefix)) {
    throw new RangeError(`IPv6 prefix must be an integer from 0 to 128, got ${String(prefix)}.`);
  }
  const bytes = parseIp(ip);
  if (!bytes) return ip;
  if (bytes.length === 4) return formatIp(bytes);
  const masked = Uint8Array.from(bytes);
  for (let bit = prefix; bit < 128; bit++) masked[bit >> 3]! &= ~(0x80 >> (bit & 7));
  return `${formatIp(masked)}/${prefix}`;
}

/**
 * The hostname of a Host header value, lowercased, with its port and a trailing dot removed
 * (IPv6 literals keep their brackets), or undefined when it is not a plain `host[:port]`.
 */
export function hostHeaderName(host: string): string | undefined {
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]\s/@?#]+)(?::\d*)?$/i.exec(host);
  if (!m) return undefined;
  const name = m[1]!.toLowerCase();
  return name.endsWith('.') ? name.slice(0, -1) : name;
}

/** Whether a request's Host header names an allowed host. */
export type HostMatcher = (host: string | null) => boolean;

/**
 * Compiles `listen({ allowedHosts })`: hostnames (or IP literals, IPv6 with or without
 * brackets), matched case-insensitively against the Host header's hostname, ports ignored.
 */
export function compileAllowedHosts(list: readonly string[]): HostMatcher {
  const allowed = new Set<string>();
  for (const entry of list) {
    const bracketed =
      typeof entry === 'string' && entry.includes(':') && !entry.startsWith('[') && parseIp(entry)
        ? `[${entry}]`
        : entry;
    const name = typeof bracketed === 'string' ? hostHeaderName(bracketed) : undefined;
    if (!name) throw new HttpConfigError(`Invalid allowedHosts entry: ${JSON.stringify(entry)}`);
    allowed.add(name);
  }
  return (host) => {
    if (host === null) return false;
    const name = hostHeaderName(host);
    return name !== undefined && allowed.has(name);
  };
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
 * and unparseable URLs are not plaintext remote connections.
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
  return isLoopbackHostname(parsed.hostname) ? undefined : parsed.host;
}

/** The URL Bun.redis connects to without an explicit one: REDIS_URL, VALKEY_URL or localhost. */
export function defaultRedisUrl(): string | undefined {
  return process.env.REDIS_URL || process.env.VALKEY_URL || undefined;
}
