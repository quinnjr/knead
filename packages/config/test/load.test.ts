import { expect, test } from 'bun:test';
import { type } from 'arktype';
import { z } from 'zod';
import { defineConfig } from '../src/define.js';
import {
  ConfigKeyCollisionError,
  ConfigLoaderError,
  ConfigValidationError,
} from '../src/errors.js';
import { loadConfig } from '../src/load.js';

const schema = z.object({
  databaseUrl: z.string(),
  port: z.coerce.number().default(3000),
  jwtSecret: z.string().min(8),
});
const Cfg = defineConfig(schema);
const base = { DATABASE_URL: 'pg://x', JWT_SECRET: 'abcdefgh' };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

test('converts and validates env', async () => {
  const cfg = await loadConfig(Cfg, {}, { ...base, PATH: '/bin', HOME: '/h' });
  expect(cfg.all()).toEqual({ databaseUrl: 'pg://x', port: 3000, jwtSecret: 'abcdefgh' });
});

test('undeclared env never reaches the schema', async () => {
  const loose = defineConfig(type({ databaseUrl: 'string' }));
  const cfg = await loadConfig(loose, {}, { DATABASE_URL: 'pg://x', PATH: '/bin' });
  expect('path' in cfg.all()).toBe(false);
  const looseZod = defineConfig(z.looseObject({ databaseUrl: z.string() }));
  const cfg2 = await loadConfig(looseZod, {}, { DATABASE_URL: 'pg://x', PATH: '/bin' });
  expect('path' in cfg2.all()).toBe(false);
});

test('precedence', async () => {
  const env = { ...base, PORT: '1' };
  const a = () => ({ PORT: '2' });
  const b = () => ({ PORT: '3' });
  expect((await loadConfig(Cfg, { loaders: [a, b] }, env)).get('port')).toBe(3);
  expect((await loadConfig(Cfg, { loaders: [a, b], values: { port: 4 } }, env)).get('port')).toBe(
    4,
  );
});

test('loader order is list order, not finish order', async () => {
  const slow = async () => {
    await sleep(20);
    return { PORT: '2' };
  };
  const fast = async () => ({ PORT: '3' });
  expect((await loadConfig(Cfg, { loaders: [slow, fast] }, base)).get('port')).toBe(3);
  expect((await loadConfig(Cfg, { loaders: [fast, slow] }, base)).get('port')).toBe(2);
});

test('loaders run concurrently', async () => {
  const slow = async () => {
    await sleep(50);
    return {};
  };
  const start = performance.now();
  await loadConfig(Cfg, { loaders: [slow, slow] }, base);
  expect(performance.now() - start).toBeLessThan(90);
});

test('loader failure', async () => {
  const boom = new Error('boom');
  const ssm = async function ssm() {
    throw boom;
  };
  const error = await failure(loadConfig(Cfg, { loaders: [ssm] }, base));
  expect(error).toBeInstanceOf(ConfigLoaderError);
  expect((error as Error).message).toContain('#0 (ssm)');
  expect((error as Error).cause).toBe(boom);
  const bad = await failure(loadConfig(Cfg, { loaders: [(() => null) as never] }, base));
  expect(bad).toBeInstanceOf(ConfigLoaderError);
});

test('validation error names env keys and hides values', async () => {
  const s = defineConfig(
    z.object({
      databaseUrl: z.string(),
      jwtSecret: z.string().refine((v) => v.length >= 8, { message: 'bad secret short' }),
    }),
  );
  const error = await failure(loadConfig(s, {}, { DATABASE_URL: 'pg://x', JWT_SECRET: 'short' }));
  expect(error).toBeInstanceOf(ConfigValidationError);
  const e = error as ConfigValidationError;
  expect(e.message).toContain('JWT_SECRET (jwtSecret): Invalid value');
  expect(e.message).not.toContain('short');
  expect(e.issues[0]?.path).toEqual(['jwtSecret']);
});

test('missing key', async () => {
  const error = await failure(loadConfig(Cfg, {}, { JWT_SECRET: 'abcdefgh' }));
  expect((error as Error).message).toContain('DATABASE_URL (databaseUrl): Missing value');
});

test('empty string is a value', async () => {
  const cfg = await loadConfig(Cfg, {}, { ...base, DATABASE_URL: '' });
  expect(cfg.get('databaseUrl')).toBe('');
  const strict = defineConfig(z.object({ databaseUrl: z.string().min(1) }));
  const error = await failure(loadConfig(strict, {}, { DATABASE_URL: '' }));
  expect((error as Error).message).toContain('DATABASE_URL (databaseUrl): Invalid value');
  expect((error as Error).message).not.toContain('Missing value');
});

test('collision in env on a declared key throws ConfigKeyCollisionError', async () => {
  const s = defineConfig(z.object({ port1: z.string() }));
  const error = await failure(loadConfig(s, {}, { PORT1: 'a', PORT_1: 'b' }));
  expect(error).toBeInstanceOf(ConfigKeyCollisionError);
});
