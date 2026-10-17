import { afterEach, describe, expect, test } from 'bun:test';
import { InjectionContextError, InjectionToken, inject, Module } from '@knead-js/core';
import { Test, type TestingModule } from '@knead-js/testing';
import { z } from 'zod';
import {
  Config,
  ConfigLoaderError,
  ConfigModule,
  ConfigValidationError,
  defineConfig,
} from '../src/index.js';

const Cfg = defineConfig(z.object({ port: z.coerce.number() }), { name: 'Cfg' });

let mod: TestingModule | undefined;
const saved = { PORT: process.env.PORT, API_KEY: process.env.API_KEY };
afterEach(async () => {
  await mod?.close();
  mod = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('ConfigModule', () => {
  test('forRoot injects typed config', async () => {
    process.env.PORT = '4000';
    class Svc {
      readonly cfg = inject(Cfg);
    }
    mod = await Test.createModule({
      imports: [ConfigModule.forRoot(Cfg)],
      providers: [Svc],
    }).compile();
    expect(mod.get(Svc).cfg.get('port')).toBe(4000);

    await mod.close();
    mod = await Test.createModule({
      imports: [ConfigModule.forRoot(Cfg, { values: { port: 5000 } })],
      providers: [Svc],
    }).compile();
    expect(mod.get(Svc).cfg.get('port')).toBe(5000);
  });

  test('is global', async () => {
    process.env.PORT = '1234';
    class Inner {
      readonly cfg = inject(Cfg);
    }
    @Module({ providers: [Inner], exports: [Inner] })
    class InnerModule {}
    mod = await Test.createModule({
      imports: [ConfigModule.forRoot(Cfg), InnerModule],
    }).compile();
    expect(mod.get(Inner).cfg.get('port')).toBe(1234);
  });

  test('forRootAsync injects deps once, loaders run once', async () => {
    delete process.env.PORT;
    const client = { fetch: () => ({ PORT: '7000' }) };
    const SSM_CLIENT = new InjectionToken<typeof client>('SSM_CLIENT');
    let calls = 0;
    @Module({
      providers: [
        {
          provide: SSM_CLIENT,
          useFactory: async () => {
            await Bun.sleep(5);
            return client;
          },
        },
      ],
      exports: [SSM_CLIENT],
    })
    class SsmModule {}
    mod = await Test.createModule({
      imports: [
        ConfigModule.forRootAsync(Cfg, {
          imports: [SsmModule],
          useFactory: () => {
            const c = inject(SSM_CLIENT);
            return {
              loaders: [
                () => {
                  calls++;
                  return c.fetch();
                },
              ],
            };
          },
        }),
      ],
    }).compile();
    expect(calls).toBe(1);
    expect(mod.get(Cfg).get('port')).toBe(7000);
  });

  test('a loader calling inject() fails clearly', async () => {
    delete process.env.PORT;
    const error = await Test.createModule({
      imports: [
        ConfigModule.forRootAsync(Cfg, {
          useFactory: () => ({
            loaders: [
              async () => {
                await Bun.sleep(1);
                inject(Cfg);
                return {};
              },
            ],
          }),
        }),
      ],
    })
      .compile()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(ConfigLoaderError);
    expect((error as ConfigLoaderError).cause).toBeInstanceOf(InjectionContextError);
  });

  test('validation failure stops boot', async () => {
    delete process.env.PORT;
    await expect(
      Test.createModule({ imports: [ConfigModule.forRoot(Cfg)] }).compile(),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('two handles in one app', async () => {
    process.env.PORT = '1';
    process.env.API_KEY = 'k';
    const A = defineConfig(z.object({ port: z.coerce.number() }), { name: 'A' });
    const B = defineConfig(z.object({ apiKey: z.string() }), { name: 'B' });
    mod = await Test.createModule({
      imports: [ConfigModule.forRoot(A), ConfigModule.forRoot(B)],
    }).compile();
    expect(mod.get(A).all()).toEqual({ port: 1 });
    expect(mod.get(B).all()).toEqual({ apiKey: 'k' });
  });

  test('config is frozen after boot', async () => {
    process.env.PORT = '10';
    mod = await Test.createModule({ imports: [ConfigModule.forRoot(Cfg)] }).compile();
    process.env.PORT = '20';
    expect(mod.get(Cfg).get('port')).toBe(10);
    expect(Object.isFrozen(mod.get(Cfg).all())).toBe(true);
  });

  test('testing override', async () => {
    delete process.env.PORT;
    class Svc {
      readonly cfg = inject(Cfg);
    }
    mod = await Test.createModule({
      imports: [ConfigModule.forRoot(Cfg)],
      providers: [Svc],
    })
      .overrideProvider(Cfg)
      .useValue(new Config({ port: 9 }))
      .compile();
    expect(mod.get(Svc).cfg.get('port')).toBe(9);
  });
});
