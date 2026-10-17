import { describe, expect, test } from 'bun:test';
import { HttpConfigError } from '../src/exceptions.js';
import {
  cidrMatcher,
  compileTrust,
  formatIp,
  maskIp,
  normalizeIp,
  parseIp,
  resolveClientIp,
  resolveSecure,
} from '../src/net.js';

describe('normalizeIp', () => {
  test('normalizeIp strips the IPv4-mapped prefix', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('::1')).toBe('::1');
  });

  test('normalizeIp canonicalizes from the parsed bytes', () => {
    expect(normalizeIp('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(normalizeIp('::FFFF:0A00:0001')).toBe('10.0.0.1');
    expect(normalizeIp('0:0:0:0:0:0:0:1')).toBe('::1');
    expect(normalizeIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(normalizeIp('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
    expect(normalizeIp('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1');
    expect(normalizeIp('0:0:0:0:0:0:0:0')).toBe('::');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('not-an-ip')).toBe('not-an-ip');
  });

  test('formatIp renders 4 and 16 byte addresses', () => {
    expect(formatIp(Uint8Array.from([192, 0, 2, 1]))).toBe('192.0.2.1');
    expect(formatIp(parseIp('2001:db8::')!)).toBe('2001:db8::');
  });
});

describe('cidrMatcher', () => {
  test('matches IPv4 and IPv6 ranges, including mapped addresses', () => {
    const trusted = cidrMatcher(['10.0.0.0/8', '::1', 'fd00::/8', '192.168.1.128/25']);
    expect(trusted('10.2.3.4')).toBe(true);
    expect(trusted('::ffff:10.9.9.9')).toBe(true);
    expect(trusted('11.0.0.1')).toBe(false);
    expect(trusted('::1')).toBe(true);
    expect(trusted('fd12::1')).toBe(true);
    expect(trusted('fe80::1')).toBe(false);
    expect(trusted('192.168.1.200')).toBe(true);
    expect(trusted('192.168.1.100')).toBe(false);
    expect(trusted('garbage')).toBe(false);
  });

  test('IPv4-mapped CIDR entries match as IPv4 /(prefix - 96)', () => {
    const trusted = cidrMatcher([
      '::ffff:10.0.0.0/104',
      '::ffff:192.168.1.1',
      '::ffff:0a0b:0000/112',
    ]);
    expect(trusted('10.200.0.1')).toBe(true);
    expect(trusted('::ffff:10.200.0.1')).toBe(true);
    expect(trusted('11.0.0.1')).toBe(false);
    expect(trusted('192.168.1.1')).toBe(true);
    expect(trusted('192.168.1.2')).toBe(false);
    expect(trusted('10.11.9.9')).toBe(true);
    expect(() => cidrMatcher(['::ffff:10.0.0.0/95'])).toThrow(HttpConfigError);
    expect(() => cidrMatcher(['::ffff:10.0.0.0/129'])).toThrow(HttpConfigError);
  });

  test('rejects invalid entries', () => {
    expect(() => cidrMatcher(['10.0.0.0/33'])).toThrow(HttpConfigError);
    expect(() => cidrMatcher(['nope'])).toThrow(HttpConfigError);
  });

  test('rejects loose prefixes that Number() would accept', () => {
    // `Number('')` is 0, so an empty prefix used to become /0 and trust every address.
    for (const entry of [
      '10.0.0.0/',
      '10.0.0.0/0x8',
      '10.0.0.0/8/x',
      '10.0.0.0/ 8',
      '10.0.0.0/8 ',
      '10.0.0.0/1e1',
      '10.0.0.0/+8',
      '10.0.0.0/8.0',
      '10.0.0.0/0008',
    ]) {
      expect(() => cidrMatcher([entry]), entry).toThrow(HttpConfigError);
    }
  });

  test('rejects non-string entries', () => {
    expect(() => cidrMatcher([8 as unknown as string])).toThrow(HttpConfigError);
    expect(() => cidrMatcher([null as unknown as string])).toThrow(HttpConfigError);
  });
});

describe('resolveClientIp', () => {
  test('no trust uses the socket address', () => {
    expect(resolveClientIp('::ffff:1.2.3.4', '9.9.9.9', compileTrust(false))).toBe('1.2.3.4');
    expect(resolveClientIp(undefined, null, compileTrust(false))).toBeUndefined();
  });

  test('hop count ignores spoofed left-most entries', () => {
    const trust = compileTrust(1);
    expect(resolveClientIp('10.0.0.1', '203.0.113.9', trust)).toBe('203.0.113.9');
    expect(resolveClientIp('10.0.0.1', '6.6.6.6, 203.0.113.9', trust)).toBe('203.0.113.9');
    expect(resolveClientIp('10.0.0.1', null, trust)).toBe('10.0.0.1');
  });

  test('hop count ignores X-Forwarded-For with fewer entries than hops', () => {
    expect(resolveClientIp('10.0.0.1', '203.0.113.9', compileTrust(5))).toBe('10.0.0.1');
    expect(resolveClientIp('10.0.0.1', '203.0.113.9', compileTrust(2))).toBe('10.0.0.1');
    expect(resolveClientIp('10.0.0.1', '203.0.113.9, 10.0.0.2', compileTrust(2))).toBe(
      '203.0.113.9',
    );
  });

  test('CIDR trust returns the first untrusted address from the right', () => {
    const trust = compileTrust(['10.0.0.0/8']);
    expect(resolveClientIp('10.0.0.5', '6.6.6.6, 203.0.113.9, 10.0.0.7', trust)).toBe(
      '203.0.113.9',
    );
    expect(resolveClientIp('8.8.8.8', '203.0.113.9', trust)).toBe('8.8.8.8');
    expect(resolveClientIp('10.0.0.5', '10.0.0.6', trust)).toBe('10.0.0.6');
  });

  test('invalid hop counts are configuration errors', () => {
    expect(() => compileTrust(-1)).toThrow(HttpConfigError);
    expect(() => compileTrust(1.5)).toThrow(HttpConfigError);
  });
});

describe('resolveClientIp with invalid entries', () => {
  test('hop mode falls back to the nearest valid address to the right', () => {
    expect(resolveClientIp('10.0.0.1', 'unknown', compileTrust(1))).toBe('10.0.0.1');
    expect(resolveClientIp('10.0.0.1', 'unknown, 10.0.0.2', compileTrust(2))).toBe('10.0.0.2');
  });
  test('CIDR mode falls back to the nearest valid address to the right', () => {
    const trust = compileTrust(['10.0.0.0/8']);
    expect(resolveClientIp('10.0.0.1', 'unknown', trust)).toBe('10.0.0.1');
    expect(resolveClientIp('10.0.0.1', '1.2.3.4, unknown, 10.0.0.2', trust)).toBe('10.0.0.2');
  });
});

describe('resolveSecure', () => {
  test('TLS listeners are always secure', () => {
    expect(resolveSecure(true, '1.1.1.1', null, null, compileTrust(false))).toBe(true);
  });
  test('X-Forwarded-Proto is honoured only from a trusted peer', () => {
    expect(resolveSecure(false, '10.0.0.1', null, 'https', compileTrust(false))).toBe(false);
    expect(resolveSecure(false, '10.0.0.1', null, 'https', compileTrust(1))).toBe(true);
    expect(resolveSecure(false, '10.0.0.1', null, 'HTTPS', compileTrust(['10.0.0.0/8']))).toBe(
      true,
    );
    expect(resolveSecure(false, '8.8.8.8', null, 'https', compileTrust(['10.0.0.0/8']))).toBe(
      false,
    );
    expect(resolveSecure(false, '10.0.0.1', null, 'http', compileTrust(1))).toBe(false);
  });
  test('hop mode ignores X-Forwarded-Proto with fewer entries than hops', () => {
    expect(resolveSecure(false, '10.0.0.1', null, 'https', compileTrust(2))).toBe(false);
    expect(resolveSecure(false, '10.0.0.1', null, 'https, https', compileTrust(2))).toBe(true);
  });
  test('a client-supplied left-most value cannot upgrade the scheme', () => {
    expect(resolveSecure(false, '10.0.0.1', null, 'https, http', compileTrust(1))).toBe(false);
  });
  test('the value is anchored to the outermost trusted proxy', () => {
    expect(resolveSecure(false, '10.0.0.1', 'client, proxy', 'https, http', compileTrust(2))).toBe(
      true,
    );
    const cidr = compileTrust(['10.0.0.0/8']);
    expect(
      resolveSecure(false, '10.0.0.1', '203.0.113.9, 10.0.0.2', 'https, http, http', cidr),
    ).toBe(false);
    expect(
      resolveSecure(false, '10.0.0.1', '203.0.113.9, 10.0.0.2', 'http, https, http', cidr),
    ).toBe(true);
  });
});

describe('maskIp', () => {
  test('masks IPv6 to the prefix and leaves IPv4 alone', () => {
    expect(maskIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd', 64)).toBe('2001:db8:1:2::/64');
    expect(maskIp('2001:db8::1', 0)).toBe('::/0');
    expect(maskIp('2001:db8::1', 128)).toBe('2001:db8::1/128');
    expect(maskIp('203.0.113.9', 64)).toBe('203.0.113.9');
    expect(maskIp('not-an-ip', 64)).toBe('not-an-ip');
  });

  test('IPv4-mapped input is returned in its IPv4 form', () => {
    expect(maskIp('::ffff:1.2.3.4', 64)).toBe('1.2.3.4');
    expect(maskIp('::ffff:0102:0304', 64)).toBe('1.2.3.4');
    expect(maskIp('::FFFF:1.2.3.4', 128)).toBe('1.2.3.4');
  });

  test('the prefix must be an integer from 0 to 128', () => {
    for (const bad of [-1, 129, 1.5, Number.NaN, Infinity]) {
      expect(() => maskIp('2001:db8::1', bad)).toThrow(RangeError);
      expect(() => maskIp('1.2.3.4', bad)).toThrow(RangeError);
    }
  });
});
