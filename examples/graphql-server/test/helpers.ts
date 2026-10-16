import type { GraphQLPayload, GraphQLSubscription, TestingModuleBuilder } from '@knead/testing';
import { Test, type TestApp, type TestingModule } from '@knead/testing';
import { AppModule } from '../src/app.module.js';

export const ada = { authorization: 'Bearer ada-token' }; // admin, author a1
export const grace = { authorization: 'Bearer grace-token' }; // author a2, no roles
export const frontend = 'http://localhost:5173';

export interface Started {
  mod: TestingModule;
  app: TestApp;
}

/** Boots the whole AppModule on a random port. */
export async function start(
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<Started> {
  const mod = await configure(Test.createModule({ imports: [AppModule] })).compile({
    development: false,
  });
  return { mod, app: await mod.createApp() };
}

/**
 * Runs `trigger` until the subscription yields. The server registers a subscription shortly
 * after connection_ack (and a Redis SUBSCRIBE takes a round trip), so an event published at once
 * could be missed. Retrying works for every PubSub engine.
 */
export async function nextEvent<T>(
  sub: GraphQLSubscription<T>,
  trigger: () => Promise<unknown>,
  attempts = 40,
): Promise<GraphQLPayload<T>> {
  const next = sub.next();
  for (let i = 0; i < attempts; i++) {
    await trigger();
    const result = await Promise.race([next, Bun.sleep(50).then(() => undefined)]);
    if (result) {
      if (result.done) throw new Error('subscription ended without an event');
      return result.value;
    }
  }
  throw new Error('no subscription event received');
}
