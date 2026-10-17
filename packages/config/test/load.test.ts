import { expect, test } from 'bun:test';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import { type } from 'arktype';
import * as v from 'valibot';
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
  const looseValibot = defineConfig(
    toStandardJsonSchema(v.looseObject({ databaseUrl: v.string() })),
  );
  const cfg3 = await loadConfig(looseValibot, {}, { DATABASE_URL: 'pg://x', PATH: '/bin' });
  expect(cfg3.all()).toEqual({ databaseUrl: 'pg://x' });
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
  const events: string[] = [];
  const loader = (id: string) => async () => {
    events.push(`start ${id}`);
    await sleep(10);
    events.push(`finish ${id}`);
    return {};
  };
  await loadConfig(Cfg, { loaders: [loader('a'), loader('b')] }, base);
  expect(events.indexOf('start b')).toBeLessThan(events.indexOf('finish a'));
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
  expect((bad as Error).message).toContain('#0');
  expect((bad as Error).cause).toBeInstanceOf(TypeError);
  expect(((bad as Error).cause as Error).message).toBe('Config loader must return an object.');
});

test('loader error cause is not enumerable, so it never shows in JSON', async () => {
  const error = await failure(
    loadConfig(Cfg, { loaders: [() => Promise.reject(new Error('boom'))] }, base),
  );
  expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
  expect(JSON.stringify(error)).not.toContain('boom');
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

test('collision inside a loader names the loader', async () => {
  const s = defineConfig(z.object({ port1: z.string() }));
  const error = await failure(
    loadConfig(s, { loaders: [() => ({ PORT1: 'a', PORT_1: 'b' })] }, {}),
  );
  expect(error).toBeInstanceOf(ConfigKeyCollisionError);
  expect((error as Error).message).toContain('loader #0');
  expect((error as Error).message).not.toContain("'a'");
});

test('values: undefined is skipped, undeclared keys are ignored', async () => {
  const cfg = await loadConfig(
    Cfg,
    { values: { port: undefined, extra: 'x' } as never },
    { ...base, PORT: '5' },
  );
  expect(cfg.get('port')).toBe(5);
  expect('extra' in cfg.all()).toBe(false);
});

test('an issue on a value-sourced key is named by the camel key', async () => {
  const error = await failure(loadConfig(Cfg, { values: { jwtSecret: 'short' } }, base));
  expect((error as ConfigValidationError).issues[0]?.name).toBe('jwtSecret');
  expect((error as Error).message).toContain('jwtSecret (jwtSecret): Invalid value');
  expect((error as Error).message).not.toContain('short');
});

test('a schema that throws while validating does not leak the value', async () => {
  const s = defineConfig(z.object({ token: z.string().transform((t) => JSON.parse(t)) }));
  const error = await failure(loadConfig(s, {}, { TOKEN: 'supersecretvalue' }));
  expect(error).toBeInstanceOf(ConfigValidationError);
  expect((error as Error).message).toContain('Config schema threw while validating');
  expect((error as Error).message).not.toContain('supersecretvalue');
  expect(Bun.inspect(error)).not.toContain('supersecretvalue');
  expect((error as Error).cause).toBeUndefined();
});

test('a root-level issue is reported as (schema) (root)', async () => {
  const s = defineConfig(z.object({ a: z.string() }).refine(() => false, { message: 'leak' }));
  const error = await failure(loadConfig(s, {}, { A: 'x' }));
  const e = error as ConfigValidationError;
  expect(e.issues).toEqual([
    { key: '(root)', name: '(schema)', path: [], message: 'Invalid value' },
  ]);
  expect(e.message).toBe('Config validation failed:\n  (schema) ((root)): Invalid value');
});

test('duplicate issues for one key are listed once', async () => {
  const s = defineConfig(
    z.object({
      jwtSecret: z
        .string()
        .refine(() => false)
        .refine(() => false),
    }),
  );
  const error = await failure(loadConfig(s, {}, { JWT_SECRET: 'x' }));
  expect((error as ConfigValidationError).issues).toHaveLength(1);
  expect((error as Error).message).toBe(
    'Config validation failed:\n  JWT_SECRET (jwtSecret): Invalid value',
  );
});

test('a nested issue is truncated to its declared key', async () => {
  const s = defineConfig(z.object({ db: z.object({ host: z.string() }) }));
  const error = await failure(loadConfig(s, { values: { db: { host: 1 } } as never }, {}));
  const e = error as ConfigValidationError;
  expect(e.issues[0]).toEqual({
    key: 'db',
    name: 'db',
    path: ['db'],
    message: 'Invalid value',
  });
  expect(e.message).toContain('db (db): Invalid value');
  expect(e.message).not.toContain('host');
});

test('keys produced from a secret never reach the message or inspect output', async () => {
  const s = defineConfig(
    z.object({
      creds: z
        .string()
        .transform((raw) => JSON.parse(raw) as unknown)
        .pipe(z.record(z.string(), z.number())),
    }),
  );
  const error = await failure(loadConfig(s, {}, { CREDS: '{"supersecretkey":"x"}' }));
  const e = error as ConfigValidationError;
  expect(e.message).not.toContain('supersecretkey');
  expect(Bun.inspect(error)).not.toContain('supersecretkey');
  expect(e.issues[0]?.path).toEqual(['creds']);
});

test('root issues with an undeclared path key never leak the value', async () => {
  const s = defineConfig(
    z.object({ token: z.string() }).superRefine((val, ctx) => {
      ctx.addIssue({ code: 'custom', path: [val.token], message: val.token });
    }),
  );
  const error = await failure(loadConfig(s, {}, { TOKEN: 'supersecretvalue' }));
  const e = error as ConfigValidationError;
  expect(e.message).not.toContain('supersecretvalue');
  expect(Bun.inspect(error)).not.toContain('supersecretvalue');
  expect(e.issues[0]).toEqual({
    key: '(root)',
    name: '(schema)',
    path: [],
    message: 'Invalid value',
  });
});
