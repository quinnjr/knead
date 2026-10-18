import { afterEach, describe, expect, test } from 'bun:test';
import { LOGGER, type Logger } from '@knead-js/http';
import { Test, type TestingModule } from '@knead-js/testing';
import { GraphQLModule, PUBSUB, PubSub, Query, Resolver } from '../src/index.js';

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

describe('a hand-built PubSub', () => {
  async function throwingSubscriber(pubsub: PubSub, message: string) {
    const original = console.error;
    const leaked: unknown[] = [];
    console.error = (...args: unknown[]) => leaked.push(args);
    try {
      pubsub.subscribe('t', () => {
        throw new Error(message);
      });
      pubsub.publish('t', 1);
      await Bun.sleep(5);
    } finally {
      console.error = original;
    }
    return leaked;
  }

  test('passed as `pubsub` logs a throwing subscriber through LOGGER, redacted', async () => {
    const logger = spyLogger();
    const pubsub = new PubSub();
    mod = await Test.createModule({ imports: [GraphQLModule.forRoot({ pubsub })], providers: [Q] })
      .overrideProvider(LOGGER)
      .useValue(logger)
      .compile({ development: false });
    const leaked = await throwingSubscriber(pubsub, 'boom at redis://ada:hunter2@db');
    expect(leaked).toEqual([]);
    const logged = JSON.stringify(logger.errors.map((a) => a.map(String)));
    expect(logged).toContain('boom at');
    expect(logged).not.toContain('hunter2');
  });

  test('keeps a logger passed to its constructor', async () => {
    const own = spyLogger();
    const app = spyLogger();
    const pubsub = new PubSub({ logger: own });
    mod = await Test.createModule({ imports: [GraphQLModule.forRoot({ pubsub })], providers: [Q] })
      .overrideProvider(LOGGER)
      .useValue(app)
      .compile({ development: false });
    expect(await throwingSubscriber(pubsub, 'own boom')).toEqual([]);
    expect(JSON.stringify(own.errors.map((a) => a.map(String)))).toContain('own boom');
    expect(app.errors).toEqual([]);
  });
});

describe('leavenLogger summarizes outside development', () => {
  test('production: an Error argument becomes Name: message, redacted', async () => {
    const { leavenLogger } = await import('../src/pubsub.js');
    const logger = spyLogger();
    const error = Object.assign(new Error('dial redis://u:p@h failed'), { token: 't' });
    leavenLogger(logger, false).error('Leaven failed', error);
    expect(logger.errors[0]).toEqual(['Leaven failed', 'Error: dial redis://***@h failed']);
  });

  test('development: the full error, redacted', async () => {
    const { leavenLogger } = await import('../src/pubsub.js');
    const logger = spyLogger();
    const plain = new Error('plain');
    leavenLogger(logger, true).error('x', plain, { authorization: 'Bearer t' });
    expect(logger.errors[0]).toEqual(['x', plain, { authorization: '***' }]);
  });
});
