import { describe, expect, mock, test } from 'bun:test';
import type { RedisClient } from 'bun';
import {
  isLoopbackHostname,
  ownedRedisClientOptions,
  parseIp,
  plaintextRedisHost,
  type RedisDeadline,
  sendRedisCommand,
} from '../src/index.js';

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

test('plaintextRedisHost returns undefined for a URL with no host', () => {
  expect(plaintextRedisHost('redis://')).toBeUndefined();
  expect(plaintextRedisHost('redis:///0')).toBeUndefined();
  expect(plaintextRedisHost('valkey://')).toBeUndefined();
});

describe('sendRedisCommand', () => {
  type Fake = { connected: boolean; connect: () => Promise<void>; connects: number };
  function fake(connected: boolean, connectDelay = 0): Fake & RedisClient {
    const client = {
      connected,
      connects: 0,
      async connect() {
        client.connects++;
        await Bun.sleep(connectDelay);
        client.connected = true;
      },
    };
    return client as unknown as Fake & RedisClient;
  }

  test('a connected client sends right away', async () => {
    const client = fake(true);
    expect(await sendRedisCommand(client, async () => 'OK', 50)).toBe('OK');
    expect(client.connects).toBe(0);
  });

  test('a disconnected client is connected first, unless connect is false', async () => {
    const client = fake(false);
    expect(await sendRedisCommand(client, async () => 'OK', 50)).toBe('OK');
    expect(client.connects).toBe(1);
    const other = fake(false);
    expect(await sendRedisCommand(other, async () => 'OK', 50, false)).toBe('OK');
    expect(other.connects).toBe(0);
  });

  test('rejects after timeoutMs and never sends once it has passed', async () => {
    const client = fake(false, 60);
    const send = mock(async () => 'OK');
    await expect(sendRedisCommand(client, send, 20)).rejects.toThrow(
      'Redis did not answer within 20ms',
    );
    await Bun.sleep(80);
    expect(send).not.toHaveBeenCalled();
  });

  test('send sees deadline.expired once the timeout has fired', async () => {
    const seen: boolean[] = [];
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    const send = async (deadline: RedisDeadline) => {
      seen.push(deadline.expired);
      await Bun.sleep(40);
      seen.push(deadline.expired);
      done();
      return 'late';
    };
    await expect(sendRedisCommand(fake(true), send, 10)).rejects.toThrow('within 10ms');
    await finished;
    expect(seen).toEqual([false, true]);
  });

  test('timeoutMs must be an integer of at least 1', async () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
      await expect(sendRedisCommand(fake(true), async () => 'OK', timeoutMs)).rejects.toThrow(
        RangeError,
      );
    }
  });
});

test('ownedRedisClientOptions: no offline queue and a bounded connection timeout', () => {
  expect(ownedRedisClientOptions(250)).toEqual({
    enableOfflineQueue: false,
    connectionTimeout: 1_000,
  });
  expect(ownedRedisClientOptions(5_000)).toEqual({
    enableOfflineQueue: false,
    connectionTimeout: 5_000,
  });
});
