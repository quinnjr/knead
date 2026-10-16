import { describe, expect, test } from 'bun:test';
import { isLoopbackHostname, parseIp, plaintextRedisHost } from '../src/index.js';

describe('parseIp', () => {
  test('IPv4, IPv6, mapped IPv4, zones and invalid input', () => {
    expect([...parseIp('127.0.0.1')!]).toEqual([127, 0, 0, 1]);
    const loop = parseIp('::1')!;
    expect(loop.length).toBe(16);
    expect(loop[15]).toBe(1);
    expect([...parseIp('::ffff:10.0.0.1')!]).toEqual([10, 0, 0, 1]);
    expect(parseIp('fe80::1%eth0')!.length).toBe(16);
    expect(parseIp('999.1.1.1')).toBeUndefined();
    expect(parseIp('1::2::3')).toBeUndefined();
    expect(parseIp('not-an-ip')).toBeUndefined();
  });
});

describe('isLoopbackHostname', () => {
  test('localhost, 127.0.0.0/8 and ::1 (also mapped and bracketed)', () => {
    for (const host of [
      'localhost',
      'LOCALHOST.',
      '127.0.0.1',
      '127.9.9.9',
      '[::1]',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLoopbackHostname(host)).toBe(true);
    }
    for (const host of ['example.com', '10.0.0.1', '::2', 'localhost.example']) {
      expect(isLoopbackHostname(host)).toBe(false);
    }
  });
});

describe('plaintextRedisHost', () => {
  test('plain redis:// and valkey:// to a remote host', () => {
    expect(plaintextRedisHost('redis://cache.internal:6379')).toBe('cache.internal:6379');
    expect(plaintextRedisHost('valkey://u:p@10.0.0.5')).toBe('10.0.0.5');
    expect(plaintextRedisHost('redis://[2001:db8::1]:6379')).toBe('[2001:db8::1]:6379');
  });

  test('TLS, Unix sockets, loopback and garbage are not plaintext remote', () => {
    for (const url of [
      'rediss://cache.internal',
      'valkeys://cache.internal',
      'redis+unix:///tmp/redis.sock',
      'redis://localhost:6379',
      'redis://LOCALHOST.:6379',
      'redis://127.0.0.1',
      'redis://127.9.9.9',
      'redis://[::1]:6379',
      'redis://[::ffff:127.0.0.1]:6379',
      'not a url',
      '',
      undefined,
    ]) {
      expect(plaintextRedisHost(url)).toBeUndefined();
    }
  });
});
