import { afterEach, describe, expect, test } from 'bun:test';
import { LOGGER, type Logger } from '@hpmws/http';
import { Test, type TestingModule } from '@hpmws/testing';
import { GraphQLModule, PUBSUB, Query, Resolver } from '../src/index.js';

@Resolver()
class Q {
  @Query(() => String)
  ok(): string {
    return 'ok';
  }
}

function spyLogger(): Logger & { errors: unknown[][] } {
  const errors: unknown[][] = [];
  const noop = () => {};
  return {
    errors,
    debug: noop,
    info: noop,
    warn: noop,
    error: (...args: unknown[]) => errors.push(args),
  };
}

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

describe("Leaven's diagnostics go through LOGGER", () => {
  test('a throwing subscriber callback on the default in-memory PubSub is logged via LOGGER', async () => {
    const logger = spyLogger();
    mod = await Test.createModule({ imports: [GraphQLModule.forRoot({})], providers: [Q] })
      .overrideProvider(LOGGER)
      .useValue(logger)
      .compile({ development: false });
    const pubsub = mod.get(PUBSUB) as {
      subscribe(t: string, cb: (p: unknown) => void): unknown;
      publish(t: string, p: unknown): unknown;
    };
    const original = console.error;
    const leaked: unknown[] = [];
    console.error = (...args: unknown[]) => leaked.push(args);
    try {
      pubsub.subscribe('t', () => {
        throw new Error('subscriber boom');
      });
      await pubsub.publish('t', 1);
      await Bun.sleep(5);
    } finally {
      console.error = original;
    }
    expect(leaked).toEqual([]);
    expect(JSON.stringify(logger.errors.map((a) => a.map(String)))).toContain('subscriber boom');
  });
});
