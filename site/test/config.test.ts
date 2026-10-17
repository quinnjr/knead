import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigDefinitionError,
  ConfigKeyCollisionError,
  ConfigLoaderError,
  ConfigModule,
  ConfigValidationError,
  defineConfig,
  loadConfig,
} from '@knead-js/config';
import { InjectionContextError, inject } from '@knead-js/core';
import { Test } from '@knead-js/testing';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import { AppConfig } from '../snippets/config/app-config.js';
import { AppModule as AsyncAppModule, SECRET_STORE } from '../snippets/config/async.js';
import { migrationTarget } from '../snippets/config/load-config.js';
import { jsonFile } from '../snippets/config/loaders.js';
import { SignupService } from '../snippets/config/signup.service.js';
import { AppModule as ValuesAppModule } from '../snippets/config/values.js';
import '../snippets/config/testing.js';

const env = {
  DATABASE_URL: 'postgres://shop:hunter2@db.internal:5432/shop',
  JWT_SECRET: 'a-production-secret-of-32-chars!',
};

async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: Error) => error,
  );
}

describe('config: keys and defaults', () => {
  test('converts SCREAMING_SNAKE_CASE names and applies schema defaults', async () => {
    const config = await loadConfig(AppConfig, {}, { ...env, PORT: '8080', HOME: '/root' });
    expect(config.all()).toEqual({
      port: 8080,
      databaseUrl: env.DATABASE_URL,
      jwtSecret: env.JWT_SECRET,
      signupsOpen: false,
    });
    expect(AppConfig.keys).toEqual(new Set(['port', 'databaseUrl', 'jwtSecret', 'signupsOpen']));
    expect(AppConfig.description).toBe('AppConfig');
  });

  test('names that are not SCREAMING_SNAKE_CASE are ignored', async () => {
    const error = await failure(
      loadConfig(AppConfig, {}, { databaseUrl: 'postgres://x/y', jwtSecret: env.JWT_SECRET }),
    );
    expect(error.message).toBe(
      'Config validation failed:\n' +
        '  DATABASE_URL (databaseUrl): Missing value\n' +
        '  JWT_SECRET (jwtSecret): Missing value',
    );
  });

  test('the migration script reads from the env it is given', async () => {
    expect(await migrationTarget(env)).toBe(env.DATABASE_URL);
  });
});

describe('config: precedence', () => {
  test('process.env < loaders (later wins) < values', async () => {
    const config = await loadConfig(
      AppConfig,
      {
        loaders: [() => ({ PORT: '4001', SIGNUPS_OPEN: 'true' }), async () => ({ PORT: '4002' })],
        values: { port: '4003' },
      },
      { ...env, PORT: '4000' },
    );
    expect(config.get('port')).toBe(4003);
    expect(config.get('signupsOpen')).toBe(true);
    const withoutValues = await loadConfig(
      AppConfig,
      { loaders: [() => ({ PORT: '4001' }), () => ({ PORT: '4002' })] },
      { ...env, PORT: '4000' },
    );
    expect(withoutValues.get('port')).toBe(4002);
  });

  test('loader keys are converted like environment names; camelCase keys are ignored', async () => {
    const error = await failure(
      loadConfig(
        AppConfig,
        { loaders: [() => ({ databaseUrl: 'postgres://x/y' })] },
        {
          JWT_SECRET: env.JWT_SECRET,
        },
      ),
    );
    expect(error.message).toBe(
      'Config validation failed:\n  DATABASE_URL (databaseUrl): Missing value',
    );
  });

  test('values snippet: code values win', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, env, { PORT: '9999' });
    try {
      const mod = await Test.createModule({
        imports: [ValuesAppModule],
        providers: [SignupService],
      }).compile();
      expect(mod.get(SignupService).port()).toBe(8080);
      expect(mod.get(SignupService).isOpen()).toBe(true);
      await mod.close();
    } finally {
      for (const key of ['DATABASE_URL', 'JWT_SECRET', 'PORT']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe('config: loaders', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test('jsonFile reads a file and returns {} when it is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knead-docs-config-'));
    const path = join(dir, 'shop.json');
    writeFileSync(path, JSON.stringify({ DATABASE_URL: 'postgres://file/shop' }));
    expect(await jsonFile(path)()).toEqual({ DATABASE_URL: 'postgres://file/shop' });
    expect(await jsonFile(join(dir, 'missing.json'))()).toEqual({});
  });

  test('a failing loader is a ConfigLoaderError named after its index and function', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knead-docs-config-'));
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not json');
    const error = await failure(loadConfig(AppConfig, { loaders: [jsonFile(path)] }, env));
    expect(error).toBeInstanceOf(ConfigLoaderError);
    expect(error.message).toBe('Config loader #0 (jsonFile) failed.');
    expect(error.cause).toBeInstanceOf(Error);
    expect(Object.keys(error)).not.toContain('cause');
  });

  test('a loader returning a non-object fails', async () => {
    const error = await failure(loadConfig(AppConfig, { loaders: [() => null as never] }, env));
    expect(error.message).toBe('Config loader #0 (anonymous) failed.');
    expect((error.cause as Error).message).toBe('Config loader must return an object.');
  });

  test('forRootAsync: useFactory injects, the loader reads the store', async () => {
    const reads: string[] = [];
    const mod = await Test.createModule({ imports: [AsyncAppModule] })
      .overrideProvider(SECRET_STORE)
      .useValue({
        read: async (path) => {
          reads.push(path);
          return { DATABASE_URL: 'postgres://vault/shop', JWT_SECRET: env.JWT_SECRET };
        },
      })
      .compile();
    expect(mod.get(AppConfig).get('databaseUrl')).toBe('postgres://vault/shop');
    expect(reads).toEqual(['shop/production']);
    await mod.close();
  });

  test('inject() inside a loader fails with InjectionContextError as the cause', async () => {
    const error = await failure(
      Test.createModule({
        imports: [
          ConfigModule.forRootAsync(AppConfig, {
            useFactory: () => ({ loaders: [() => inject(SECRET_STORE) && {}] }),
          }),
        ],
      }).compile(),
    );
    expect(error).toBeInstanceOf(ConfigLoaderError);
    expect(error.cause).toBeInstanceOf(InjectionContextError);
  });
});

describe('config: errors', () => {
  test('validation errors name sources and keys, never values', async () => {
    const error = await failure(
      loadConfig(AppConfig, {}, { PORT: 'eighty', JWT_SECRET: 'too-short-hunter2' }),
    );
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error.name).toBe('ConfigValidationError');
    expect(error.message).toBe(
      'Config validation failed:\n' +
        '  PORT (port): Invalid value\n' +
        '  DATABASE_URL (databaseUrl): Missing value\n' +
        '  JWT_SECRET (jwtSecret): Invalid value',
    );
    expect(error.message).not.toContain('hunter2');
    expect((error as ConfigValidationError).issues).toEqual([
      { key: 'port', name: 'PORT', path: ['port'], message: 'Invalid value' },
      { key: 'databaseUrl', name: 'DATABASE_URL', path: ['databaseUrl'], message: 'Missing value' },
      { key: 'jwtSecret', name: 'JWT_SECRET', path: ['jwtSecret'], message: 'Invalid value' },
    ]);
  });

  test('an issue in a code value is named by its camelCase key', async () => {
    const error = await failure(loadConfig(AppConfig, { values: { jwtSecret: 'short' } }, env));
    expect(error.message).toBe('Config validation failed:\n  jwtSecret (jwtSecret): Invalid value');
  });

  test('an empty variable is present, so it is invalid rather than missing', async () => {
    const error = await failure(loadConfig(AppConfig, {}, { ...env, DATABASE_URL: '' }));
    expect(error.message).toBe(
      'Config validation failed:\n  DATABASE_URL (databaseUrl): Invalid value',
    );
  });

  test('boot stops on a validation failure', async () => {
    const error = await failure(
      Test.createModule({
        imports: [ConfigModule.forRoot(AppConfig, { values: { jwtSecret: 'short' } })],
      }).compile(),
    );
    expect(error).toBeInstanceOf(ConfigValidationError);
  });

  test('two names mapping to one key collide', async () => {
    const Oauth = defineConfig(toStandardJsonSchema(v.object({ oauth2ClientId: v.string() })));
    const error = await failure(
      loadConfig(Oauth, {}, { OAUTH2_CLIENT_ID: 'a', OAUTH_2_CLIENT_ID: 'b' }),
    );
    expect(error).toBeInstanceOf(ConfigKeyCollisionError);
    expect(error.message).toBe(
      'process.env: OAUTH2_CLIENT_ID and OAUTH_2_CLIENT_ID both map to config key "oauth2ClientId".',
    );
    expect((error as ConfigKeyCollisionError).key).toBe('oauth2ClientId');
    expect((error as ConfigKeyCollisionError).sources).toEqual([
      'OAUTH2_CLIENT_ID',
      'OAUTH_2_CLIENT_ID',
    ]);
    const fromLoader = await failure(
      loadConfig(
        Oauth,
        { loaders: [() => ({ OAUTH2_CLIENT_ID: 'a', OAUTH_2_CLIENT_ID: 'b' })] },
        {},
      ),
    );
    expect(fromLoader.message).toStartWith('loader #0: ');
    // Different sources do not collide: the later one wins.
    const merged = await loadConfig(
      Oauth,
      { loaders: [() => ({ OAUTH_2_CLIENT_ID: 'b' })] },
      {
        OAUTH2_CLIENT_ID: 'a',
      },
    );
    expect(merged.get('oauth2ClientId')).toBe('b');
  });

  test('definition errors', () => {
    expect(() =>
      defineConfig(toStandardJsonSchema(v.object({ DATABASE_URL: v.string() }))),
    ).toThrow(
      new ConfigDefinitionError(
        'Config key "DATABASE_URL" can never be read from SCREAMING_SNAKE_CASE sources; ' +
          'declare it in camelCase ("databaseUrl").',
      ),
    );
    // @ts-expect-error a plain Valibot schema has no ~standard.jsonSchema
    expect(() => defineConfig(v.object({ port: v.string() }))).toThrow(
      'defineConfig needs a schema that implements Standard JSON Schema (~standard.jsonSchema), ' +
        'such as Zod 4.2+, ArkType 2.1.28+, or Valibot wrapped with toStandardJsonSchema().',
    );
    expect(() => defineConfig(toStandardJsonSchema(v.string()) as never)).toThrow(
      'The config schema must be an object schema with declared properties',
    );
  });
});

describe('config: secrets', () => {
  test('Config never reveals values through JSON or inspection, and is frozen', async () => {
    const config = await loadConfig(AppConfig, {}, env);
    expect(JSON.stringify(config)).toBe(
      '{"port":"[redacted]","databaseUrl":"[redacted]","jwtSecret":"[redacted]","signupsOpen":"[redacted]"}',
    );
    expect(Bun.inspect(config)).toBe(
      'Config {"port":"[redacted]","databaseUrl":"[redacted]","jwtSecret":"[redacted]","signupsOpen":"[redacted]"}',
    );
    expect(`${config}`).toBe('[object Object]');
    expect(Object.isFrozen(config.all())).toBe(true);
    expect(config.get('jwtSecret')).toBe(env.JWT_SECRET);
  });

  test('changing process.env after boot has no effect', async () => {
    const saved = process.env.SIGNUPS_OPEN;
    process.env.SIGNUPS_OPEN = 'false';
    try {
      const mod = await Test.createModule({
        imports: [
          ConfigModule.forRoot(AppConfig, {
            values: { databaseUrl: env.DATABASE_URL, jwtSecret: env.JWT_SECRET },
          }),
        ],
        providers: [SignupService],
      }).compile();
      process.env.SIGNUPS_OPEN = 'true';
      expect(mod.get(SignupService).isOpen()).toBe(false);
      await mod.close();
    } finally {
      if (saved === undefined) delete process.env.SIGNUPS_OPEN;
      else process.env.SIGNUPS_OPEN = saved;
    }
  });
});
