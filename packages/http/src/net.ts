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

export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1]! : ip;
}

export function cidrMatcher(list: readonly string[]): (ip: string) => boolean {
  const ranges = list.map((entry) => {
    const [address, bits] = entry.split('/');
    const bytes = parseIp(address ?? '');
    if (!bytes) throw new HttpConfigError(`Invalid trustProxy entry: ${entry}`);
    const prefix = bits === undefined ? bytes.length * 8 : Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bytes.length * 8) {
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
  if (trust.kind === 'hops')
    return normalizeIp(validAtOrBefore(chain, Math.min(trust.hops, chain.length - 1)));
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
  let index: number;
  if (trust.kind === 'hops') {
    // Hop-count mode: the peer is trusted by definition.
    index = trust.hops - 1;
  } else {
    if (!trust.isTrusted(remote)) return false;
    const chain = [remote, ...splitList(forwardedFor)];
    let trusted = 0;
    while (trusted < chain.length && trust.isTrusted(chain[trusted]!)) trusted++;
    index = trusted - 1;
  }
  // Index 0 is the value appended by the nearest proxy; the left-most values are client-controlled.
  const protos = splitList(forwardedProto);
  if (protos.length === 0) return false;
  return protos[Math.min(index, protos.length - 1)]!.toLowerCase() === 'https';
}
