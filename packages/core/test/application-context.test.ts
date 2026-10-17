import { afterEach, describe, expect, test } from 'bun:test';
import {
  ApplicationContext,
  CircularDependencyError,
  ConsoleLogger,
  DEVELOPMENT,
  InjectionContextError,
  InjectionToken,
  inject,
  LOGGER,
  MemoryLogger,
  Module,
  NoProviderError,
  ProviderConfigError,
} from '../src/index.js';

const CONFIG = new InjectionToken<{ url: string }>('CONFIG');
const CONN = new InjectionToken<{ url: string; open: boolean }>('CONN');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ApplicationContext.create', () => {
  test('async factories are awaited before classes that inject them', async () => {
    class Repo {
      readonly conn = inject(CONN);
    }
    @Module({
      providers: [
        Repo,
        { provide: CONFIG, useValue: { url: 'db://x' } },
        {
          provide: CONN,
          useFactory: async () => {
            const config = inject(CONFIG);
            await delay(5);
            return { url: config.url, open: true };
          },
        },
      ],
    })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    expect(ctx.get(Repo).conn).toEqual({ url: 'db://x', open: true });
  });

  test('an async factory may depend on another async factory registered later', async () => {
    const A = new InjectionToken<string>('A');
    const B = new InjectionToken<string>('B');
    let bCalls = 0;
    @Module({
      providers: [
        {
          provide: A,
          useFactory: async () => {
            const b = inject(B);
            await delay(1);
            return `a(${b})`;
          },
        },
        {
          provide: B,
          useFactory: async () => {
            bCalls++;
            await delay(1);
            return 'b';
          },
        },
      ],
    })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    expect(ctx.get(A)).toBe('a(b)');
    expect(bCalls).toBe(1);
  });

  test('inject() after await throws InjectionContextError (Review Focus 4)', async () => {
    @Module({
      providers: [
        { provide: CONFIG, useValue: { url: 'x' } },
        {
          provide: CONN,
          useFactory: async () => {
            await delay(1);
            return { url: inject(CONFIG).url, open: true };
          },
        },
      ],
    })
    class AppModule {}
    await expect(ApplicationContext.create(AppModule)).rejects.toThrow(InjectionContextError);
  });

  test('cycles through async factories are detected', async () => {
    const A = new InjectionToken<string>('A');
    const B = new InjectionToken<string>('B');
    @Module({
      providers: [
        { provide: A, useFactory: async () => `${inject(B)}` },
        { provide: B, useFactory: async () => `${inject(A)}` },
      ],
    })
    class AppModule {}
    await expect(ApplicationContext.create(AppModule)).rejects.toThrow(CircularDependencyError);
  });

  test('transient async factories are rejected', async () => {
    class UsesIt {
      readonly c = inject(CONN);
    }
    @Module({
      providers: [
        UsesIt,
        { provide: CONN, scope: 'transient', useFactory: async () => ({ url: '', open: true }) },
      ],
    })
    class AppModule {}
    await expect(ApplicationContext.create(AppModule)).rejects.toThrow(ProviderConfigError);
  });

  test('a rejecting async factory rejects create()', async () => {
    @Module({
      providers: [{ provide: CONN, useFactory: async () => Promise.reject(new Error('db down')) }],
    })
    class AppModule {}
    await expect(ApplicationContext.create(AppModule)).rejects.toThrow('db down');
  });

  test('missing dependencies fail at bootstrap, not at first use', async () => {
    class NeedsConfig {
      readonly c = inject(CONFIG);
    }
    @Module({ providers: [NeedsConfig] })
    class AppModule {}
    await expect(ApplicationContext.create(AppModule)).rejects.toThrow(NoProviderError);
  });
});

describe('get and collect', () => {
  test('get is non-strict: finds providers in any module', async () => {
    class Hidden {}
    @Module({ providers: [Hidden] })
    class Inner {}
    @Module({ imports: [Inner] })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    expect(ctx.get(Hidden)).toBeInstanceOf(Hidden);
    expect(() => ctx.get(CONFIG)).toThrow(NoProviderError);
  });

  test('collect gathers multi contributions across modules regardless of exports', async () => {
    const PLUGINS = new InjectionToken<string[]>('PLUGINS');
    @Module({ providers: [{ provide: PLUGINS, useValue: 'inner', multi: true }] })
    class Inner {}
    @Module({ imports: [Inner], providers: [{ provide: PLUGINS, useValue: 'root', multi: true }] })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    expect(ctx.collect(PLUGINS)).toEqual(['inner', 'root']);
  });

  test('collectEntries pairs each contribution with its owning injector, in collect order', async () => {
    const PLUGINS = new InjectionToken<string[]>('PLUGINS');
    @Module({ providers: [{ provide: PLUGINS, useValue: 'inner', multi: true }] })
    class Inner {}
    @Module({ imports: [Inner], providers: [{ provide: PLUGINS, useValue: 'root', multi: true }] })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    const entries = ctx.collectEntries(PLUGINS);
    expect(entries.map((e) => e.value)).toEqual(ctx.collect(PLUGINS));
    const inner = ctx.modules.find((m) => m.metatype === Inner);
    expect(inner).toBeDefined();
    expect(entries[0]?.injector === inner?.injector).toBe(true);
    expect(entries[1]?.injector === ctx.root.injector).toBe(true);
  });

  test('root is the root module and modules are in post-order', async () => {
    @Module({})
    class Inner {}
    @Module({ imports: [Inner] })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    expect(ctx.root.metatype).toBe(AppModule);
    expect(ctx.modules.map((m) => m.name)).toEqual(['Inner', 'AppModule']);
  });
});

describe('ApplicationContext.initializeLate', () => {
  test('runs init hooks on instances constructed after create, then includes them in close', async () => {
    const log: string[] = [];
    class Eager {
      onModuleInit() {
        log.push('eager:init');
      }
      onModuleDestroy() {
        log.push('eager:destroy');
      }
    }
    class Late {
      onModuleInit() {
        log.push('late:init');
      }
      onApplicationBootstrap() {
        log.push('late:bootstrap');
      }
      onModuleDestroy() {
        log.push('late:destroy');
      }
    }
    @Module({ providers: [Eager] })
    class M {}
    const ctx = await ApplicationContext.create(M);
    ctx.root.injector.resolveOrConstruct(Late);
    expect(log).toEqual(['eager:init']);
    await ctx.initializeLate();
    await ctx.initializeLate();
    expect(log).toEqual(['eager:init', 'late:init', 'late:bootstrap']);
    await ctx.close();
    expect(log.slice(3)).toEqual(['late:destroy', 'eager:destroy']);
  });

  test('transients resolved after create() are not tracked and receive no hooks', async () => {
    let inits = 0;
    let destroys = 0;
    class Transient {
      onModuleInit() {
        inits++;
      }
      onModuleDestroy() {
        destroys++;
      }
    }
    @Module({ providers: [{ provide: Transient, useClass: Transient, scope: 'transient' }] })
    class M {}
    const ctx = await ApplicationContext.create(M);
    for (let i = 0; i < 1000; i++) ctx.get(Transient);
    await ctx.initializeLate();
    await ctx.close();
    expect(inits).toBe(0);
    expect(destroys).toBe(0);
    const state = (ctx as unknown as { state: { instances: unknown[] } }).state;
    expect(state.instances.length).toBeLessThan(10);
  });

  test('a transient injected into an instance constructed late still receives hooks', async () => {
    const log: string[] = [];
    class Dep {
      onModuleInit() {
        log.push('dep:init');
      }
      onModuleDestroy() {
        log.push('dep:destroy');
      }
    }
    class LateGuard {
      readonly dep = inject(Dep);
      onModuleInit() {
        log.push('guard:init');
      }
    }
    @Module({ providers: [{ provide: Dep, useClass: Dep, scope: 'transient' }] })
    class M {}
    const ctx = await ApplicationContext.create(M);
    ctx.root.injector.resolveOrConstruct(LateGuard);
    await ctx.initializeLate();
    expect(log).toEqual(['dep:init', 'guard:init']);
    await ctx.close();
    expect(log).toEqual(['dep:init', 'guard:init', 'dep:destroy']);
  });

  test('closed is false until close() starts', async () => {
    @Module({})
    class M {}
    const ctx = await ApplicationContext.create(M);
    expect(ctx.closed).toBe(false);
    const closing = ctx.close();
    expect(ctx.closed).toBe(true);
    await closing;
  });

  test('a failing late init hook closes the context and rejects', async () => {
    const log: string[] = [];
    class Eager {
      onModuleDestroy() {
        log.push('eager:destroy');
      }
    }
    class Broken {
      onModuleInit() {
        throw new Error('late boom');
      }
      onModuleDestroy() {
        log.push('broken:destroy');
      }
    }
    @Module({ providers: [Eager] })
    class M {}
    const ctx = await ApplicationContext.create(M);
    ctx.root.injector.resolveOrConstruct(Broken);
    await expect(ctx.initializeLate()).rejects.toThrow('late boom');
    expect(log).toEqual(['eager:destroy']);
    expect(ctx.closed).toBe(true);
  });
});

describe('default LOGGER and DEVELOPMENT', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });

  @Module({})
  class Root {}

  test('provides a ConsoleLogger by default', async () => {
    const ctx = await ApplicationContext.create(Root);
    expect(ctx.get(LOGGER)).toBeInstanceOf(ConsoleLogger);
  });

  test('uses the logger option', async () => {
    const mem = new MemoryLogger();
    const ctx = await ApplicationContext.create(Root, { logger: mem });
    expect(ctx.get(LOGGER)).toBe(mem);
  });

  test('development defaults to NODE_ENV', async () => {
    process.env.NODE_ENV = 'development';
    expect((await ApplicationContext.create(Root)).get(DEVELOPMENT)).toBe(true);
    process.env.NODE_ENV = 'production';
    expect((await ApplicationContext.create(Root)).get(DEVELOPMENT)).toBe(false);
  });

  test('the development option overrides NODE_ENV', async () => {
    process.env.NODE_ENV = 'production';
    expect((await ApplicationContext.create(Root, { development: true })).get(DEVELOPMENT)).toBe(
      true,
    );
  });

  test("a global module's LOGGER wins over the default", async () => {
    const mem = new MemoryLogger();
    @Module({ global: true, providers: [{ provide: LOGGER, useValue: mem }], exports: [LOGGER] })
    class LogModule {}
    const ctx = await ApplicationContext.create(Root, { globalModules: [LogModule] });
    expect(ctx.get(LOGGER)).toBe(mem);
  });

  test('a provider inside a module can inject LOGGER without importing anything', async () => {
    class Service {
      readonly log = inject(LOGGER);
    }
    @Module({ providers: [Service], exports: [Service] })
    class Feature {}
    @Module({ imports: [Feature] })
    class App {}
    const ctx = await ApplicationContext.create(App);
    expect(ctx.get(Service).log).toBeInstanceOf(ConsoleLogger);
    expect(ctx.get(Service).log).toBe(ctx.get(LOGGER));
  });
});
