import { afterEach, describe, expect, test } from 'bun:test';
import { inject, type OnModuleInit } from '@knead-js/core';
import { APP_GUARD, WsRegistry } from '@knead-js/http';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import { AbilityGuard, CaslModule, canMeta, skipAbilityMeta } from '../src/index.js';
import { options } from './fixtures.js';

/** Sends a raw upgrade request to `path` and returns the status code. */
function upgradeStatus(app: TestApp, path: string, authorization?: string): Promise<number> {
  const port = Number(app.url.port);
  return new Promise((resolve, reject) => {
    let buf = '';
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(sock) {
          sock.write(
            [
              `GET ${path} HTTP/1.1`,
              `Host: 127.0.0.1:${port}`,
              'Upgrade: websocket',
              'Connection: Upgrade',
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
              'Sec-WebSocket-Version: 13',
              ...(authorization === undefined ? [] : [`Authorization: ${authorization}`]),
              '',
              '',
            ].join('\r\n'),
          );
        },
        data(sock, chunk) {
          buf += chunk.toString();
          if (buf.includes('\r\n')) {
            resolve(Number(buf.split(' ')[1]));
            sock.end();
          }
        },
        error(_s, e) {
          reject(e);
        },
      },
    }).catch(reject);
  });
}

class Gateway implements OnModuleInit {
  readonly ws = inject(WsRegistry);
  onModuleInit() {
    const endpoint = { upgrade: () => ({}) };
    this.ws.register('/posts-feed', endpoint, { meta: canMeta('read', 'Post') });
    this.ws.register('/billing-feed', endpoint, {
      meta: canMeta('read', 'User', 'billingAddress'),
    });
    this.ws.register('/public', endpoint, { meta: skipAbilityMeta() });
    this.ws.register('/undeclared', endpoint);
  }
}

let mod: TestingModule | undefined;
let app: TestApp | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
  app = undefined;
});

async function start(): Promise<TestApp> {
  mod = await Test.createModule({
    imports: [CaslModule.forRoot(options)],
    providers: [Gateway, { provide: APP_GUARD, multi: true, useExisting: AbilityGuard }],
  }).compile({ development: false });
  app = await mod.createApp();
  return app;
}

const auth = (user: string, grant: unknown) => `Bearer ${user}|${JSON.stringify(grant)}`;

describe('a global AbilityGuard on WebSocket endpoints', () => {
  test('canMeta() is checked against the caller ability on upgrade', async () => {
    const a = await start();
    expect(await upgradeStatus(a, '/posts-feed', auth('alice', { posts: 'read' }))).toBe(101);
    expect(await upgradeStatus(a, '/posts-feed', auth('alice', {}))).toBe(403);
    expect(await upgradeStatus(a, '/posts-feed')).toBe(401);
  });

  test('canMeta() field requirements apply', async () => {
    const a = await start();
    // The admin can read billing fields; the grant must name the billing area too.
    expect(await upgradeStatus(a, '/billing-feed', auth('admin', { billing: 'read' }))).toBe(101);
    expect(await upgradeStatus(a, '/billing-feed', auth('admin', { posts: 'read' }))).toBe(403);
    expect(await upgradeStatus(a, '/billing-feed', auth('alice', { billing: 'read' }))).toBe(403);
  });

  test('skipAbilityMeta() passes anonymous upgrades', async () => {
    const a = await start();
    expect(await upgradeStatus(a, '/public')).toBe(101);
  });

  test('an endpoint without ability meta is denied (fail closed)', async () => {
    const a = await start();
    expect(await upgradeStatus(a, '/undeclared', auth('admin', { posts: 'read' }))).toBe(403);
  });
});

describe('canMeta / skipAbilityMeta', () => {
  test('produce the same route meta as @Can / @SkipAbility', () => {
    expect(canMeta('read', 'Post')).toEqual({
      [Symbol.for('knead:casl:can')]: { action: 'read', subject: 'Post' },
    });
    expect(canMeta('read', 'User', 'email')).toEqual({
      [Symbol.for('knead:casl:can')]: { action: 'read', subject: 'User', field: 'email' },
    });
    expect(skipAbilityMeta()).toEqual({ [Symbol.for('knead:casl:skip')]: true });
  });
});
