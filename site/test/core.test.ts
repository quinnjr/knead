import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  ApplicationContext,
  CircularDependencyError,
  ConsoleLogger,
  DEVELOPMENT,
  defaultRedisUrl,
  escapeControl,
  Injectable,
  InjectionContextError,
  InjectionToken,
  inject,
  isLoopbackHostname,
  KneadError,
  LOGGED_MESSAGE_LENGTH,
  LOGGER,
  logValue,
  MAX_LOGGED_VALUE_LENGTH,
  MemoryLogger,
  MODULES,
  Module,
  ModuleDefinitionError,
  type ModuleExport,
  NoProviderError,
  normalizeProvider,
  ProviderConfigError,
  parseIp,
  plaintextRedisHost,
  redactCredentials,
  redactValue,
  summarizeError,
  tokenName,
} from '@knead-js/core';
import { CyclicModule, Invoices, Orders } from '../snippets/core/circular.js';
import { AppModule as MailApp, MailModule, MailService } from '../snippets/core/dynamic-module.js';
import {
  AppModule,
  ConnectionPool,
  Database,
  DatabaseModule,
  UsersService,
} from '../snippets/core/feature-modules.js';
import {
  FEATURE_FLAGS,
  FeatureFlagsModule,
  CheckoutService as FlagCheckout,
  AppModule as FlagsApp,
} from '../snippets/core/global-module.js';
import {
  CartService,
  CheckoutService,
  InvoiceService,
  ShopModule,
} from '../snippets/core/injection.js';
import {
  BrokenReminderService,
  buildReminderService,
  CLOCK,
  insideInjectionContext,
  START_TIME,
  startTimeProvider,
} from '../snippets/core/injection-context.js';
import { EVENTS, Database as LifecycleDb, WorkerModule } from '../snippets/core/lifecycle.js';
import { CacheModule, CacheWarmer } from '../snippets/core/logger.js';
import { auditAction, InvoiceController } from '../snippets/core/metadata.js';
import { ModuleReport, AppModule as RefApp } from '../snippets/core/module-ref.js';
import { createTestContext } from '../snippets/core/overrides.js';
import {
  AccessLog,
  APP_CONFIG,
  AuditLog,
  Cache,
  CONNECTION_LABEL,
  HealthService,
  LEGACY_CACHE,
  MemoryCache,
  PaymentsClient,
  AppModule as ProvidersApp,
} from '../snippets/core/providers.js';
import { ReportsModule, ReportsService, SharedModule } from '../snippets/core/reexport.js';
import { ReportModule, runReport } from '../snippets/core/standalone.js';

const contexts: ApplicationContext[] = [];
async function create(...args: Parameters<typeof ApplicationContext.create>) {
  const context = await ApplicationContext.create(args[0], {
    logger: new MemoryLogger(),
    ...args[1],
  });
  contexts.push(context);
  return context;
}
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => {});
});

describe('guide/modules', () => {
  test('exported providers are visible to importers, private ones are not', async () => {
    const ctx = await create(AppModule);
    expect(ctx.get(UsersService).findAll()).toEqual(['result of select * from users']);
    @Injectable()
    class NeedsPool {
      readonly pool = inject(ConnectionPool);
    }
    @Module({ imports: [DatabaseModule], providers: [NeedsPool] })
    class Bad {}
    await expect(create(Bad)).rejects.toThrow(
      'NeedsPool (Bad) requested ConnectionPool, but no provider is visible. ConnectionPool is provided by DatabaseModule but not exported.',
    );
  });

  test('exports are not transitive', async () => {
    @Injectable()
    class NeedsDb {
      readonly db = inject(Database);
    }
    @Module({ imports: [DatabaseModule] })
    class Middle {}
    @Module({ imports: [Middle], providers: [NeedsDb] })
    class Top {}
    await expect(create(Top)).rejects.toThrow(
      'Database is exported by DatabaseModule; add DatabaseModule to the imports of Top.',
    );
  });

  test('re-exporting a module exposes its exports', async () => {
    const ctx = await create(ReportsModule);
    const reports = ctx.get(ReportsService);
    expect(reports.db).toBeInstanceOf(Database);
    expect(ctx.modules.map((m) => m.name)).toEqual([
      'DatabaseModule',
      'SharedModule',
      'ReportsModule',
    ]);
    expect(SharedModule).toBeDefined();
  });

  test('a module class imported twice is one instance', async () => {
    @Module({ imports: [DatabaseModule], exports: [DatabaseModule] })
    class A {}
    @Module({ imports: [DatabaseModule] })
    class B {}
    @Module({ imports: [A, B] })
    class Root {}
    const ctx = await create(Root);
    expect(ctx.modules.filter((m) => m.metatype === DatabaseModule)).toHaveLength(1);
  });

  test('each forRoot() call is its own module instance; one object imported twice is one', async () => {
    const options = { from: 'a@example.com', transport: 'log' } as const;
    @Module({ imports: [MailModule.forRoot(options), MailModule.forRoot(options)] })
    class Twice {}
    const twice = await create(Twice);
    expect(twice.modules.filter((m) => m.metatype === MailModule)).toHaveLength(2);
    const once = MailModule.forRoot(options);
    @Module({ imports: [once, once] })
    class Shared {}
    const shared = await create(Shared);
    expect(shared.modules.filter((m) => m.metatype === MailModule)).toHaveLength(1);
  });

  test('global modules are visible without importing, but only once in the graph', async () => {
    const ctx = await create(FlagsApp);
    expect(ctx.get(FlagCheckout).flags.isEnabled('new-checkout')).toBe(true);
    // Not imported anywhere: not in the graph, so not visible.
    @Module({ imports: [] })
    class Alone {}
    @Injectable()
    class NeedsFlags {
      readonly flags = inject(FEATURE_FLAGS);
    }
    @Module({ imports: [Alone], providers: [NeedsFlags] })
    class NoFlags {}
    await expect(create(NoFlags)).rejects.toThrow(NoProviderError);
    expect(FeatureFlagsModule).toBeDefined();
  });

  test('imports win over global modules; own providers win over both', async () => {
    const T = new InjectionToken<string>('T');
    @Module({ global: true, providers: [{ provide: T, useValue: 'global' }], exports: [T] })
    class G {}
    @Module({ providers: [{ provide: T, useValue: 'import' }], exports: [T] })
    class I {}
    @Injectable()
    class Reader {
      readonly t = inject(T);
    }
    @Module({ imports: [I], providers: [Reader], exports: [Reader] })
    class ViaImport {}
    @Module({ imports: [G, ViaImport] })
    class Root1 {}
    @Module({
      imports: [I],
      providers: [Reader, { provide: T, useValue: 'own' }],
      exports: [Reader],
    })
    class Own {}
    @Module({ imports: [G, Own] })
    class Root2 {}
    @Module({ providers: [Reader], exports: [Reader] })
    class OnlyGlobal {}
    @Module({ imports: [G, OnlyGlobal] })
    class Root3 {}
    // A global module listed in imports is an ordinary import, in its place in the list.
    @Module({ imports: [G, I], providers: [Reader], exports: [Reader] })
    class ListsGlobal {}
    @Module({ imports: [ListsGlobal] })
    class Root4 {}
    expect((await create(Root1)).get(Reader).t).toBe('import');
    expect((await create(Root2)).get(Reader).t).toBe('own');
    expect((await create(Root3)).get(Reader).t).toBe('global');
    expect((await create(Root4)).get(Reader).t).toBe('global');
  });

  test('the first import that exports a token wins', async () => {
    const T = new InjectionToken<string>('T');
    @Module({ providers: [{ provide: T, useValue: 'first' }], exports: [T] })
    class First {}
    @Module({ providers: [{ provide: T, useValue: 'second' }], exports: [T] })
    class Second {}
    @Injectable()
    class Reader {
      readonly t = inject(T);
    }
    @Module({ imports: [First, Second], providers: [Reader] })
    class Root {}
    expect((await create(Root)).get(Reader).t).toBe('first');
  });

  test('a global module providing LOGGER wins over the default', async () => {
    const mine = new MemoryLogger();
    @Module({ global: true, providers: [{ provide: LOGGER, useValue: mine }], exports: [LOGGER] })
    class LogModule {}
    @Injectable()
    class UsesLog {
      readonly log = inject(LOGGER);
    }
    @Module({ imports: [LogModule], providers: [UsesLog] })
    class Root {}
    const ctx = await create(Root);
    expect(ctx.get(UsesLog).log).toBe(mine);
  });

  test('dynamic modules merge with @Module and forRootAsync factories can inject', async () => {
    const ctx = await create(MailApp);
    expect(ctx.get(MailService).send('ada@example.com', 'Hi')).toBe(
      'log: noreply@example.com -> ada@example.com: Hi',
    );
    expect(() => MailModule.forRoot({ from: 'nobody', transport: 'smtp' })).toThrow(
      'MailModule: "from" must be an email address, got "nobody".',
    );
  });

  test('importing MailModule without forRoot fails at bootstrap', async () => {
    @Module({ imports: [MailModule] })
    class Root {}
    await expect(create(Root)).rejects.toThrow(
      'MailService (MailModule) requested MAIL_OPTIONS, but no provider is visible.',
    );
  });

  test('dynamic module merge: lists concatenate, global from the dynamic object first', async () => {
    const A = new InjectionToken<string>('A');
    const B = new InjectionToken<string>('B');
    @Module({ providers: [{ provide: A, useValue: 'static' }], exports: [A], global: true })
    class M {
      static make() {
        return { module: M, providers: [{ provide: B, useValue: 'dynamic' }], exports: [B] };
      }
      static local() {
        return { module: M, global: false };
      }
    }
    @Module({ imports: [M.make()] })
    class Root {}
    const ctx = await create(Root);
    expect(ctx.root.injector.get(A)).toBe('static');
    expect(ctx.root.injector.get(B)).toBe('dynamic');
    expect(ctx.modules.find((m) => m.metatype === M)?.global).toBe(true);
    @Module({ imports: [M.local()] })
    class Root2 {}
    const ctx2 = await create(Root2);
    expect(ctx2.modules.find((m) => m.metatype === M)?.global).toBe(false);
  });

  test('exporting dynamic modules: class, object, and a re-called object', async () => {
    const A = new InjectionToken<string>('A');
    const B = new InjectionToken<string>('B');
    @Module({})
    class Feature {
      static of(token: InjectionToken<string>, value: string) {
        return {
          module: Feature,
          providers: [{ provide: token, useValue: value }],
          exports: [token],
        };
      }
    }
    @Injectable()
    class Reader {
      readonly a = inject(A, { optional: true });
      readonly b = inject(B, { optional: true });
    }
    const build = async (exports: ModuleExport[]) => {
      const va = Feature.of(A, 'a');
      @Module({ imports: [va, Feature.of(B, 'b')], exports: exports.length ? exports : [va] })
      class Middle {}
      @Module({ imports: [Middle], providers: [Reader] })
      class Root {}
      const reader = (await create(Root)).get(Reader);
      return [reader.a, reader.b];
    };
    expect(await build([Feature])).toEqual(['a', 'b']);
    expect(await build([])).toEqual(['a', undefined]);
    expect(await build([Feature.of(A, 'a')])).toEqual(['a', 'b']);
  });

  test('exporting a token of an imported module re-exports only that token', async () => {
    const A = new InjectionToken<string>('A');
    const B = new InjectionToken<string>('B');
    @Module({
      providers: [
        { provide: A, useValue: 'a' },
        { provide: B, useValue: 'b' },
      ],
      exports: [A, B],
    })
    class Inner {}
    @Module({ imports: [Inner], exports: [A] })
    class Middle {}
    @Injectable()
    class Reader {
      readonly a = inject(A);
      readonly b = inject(B, { optional: true });
    }
    @Module({ imports: [Middle], providers: [Reader] })
    class Root {}
    const reader = (await create(Root)).get(Reader);
    expect([reader.a, reader.b]).toEqual(['a', undefined]);
  });

  test('controllers are module-local providers', async () => {
    class ReportsController {}
    @Module({ controllers: [ReportsController] })
    class Reports {}
    @Injectable()
    class Needs {
      readonly c = inject(ReportsController);
    }
    @Module({ imports: [Reports], providers: [Needs] })
    class Root {}
    await expect(create(Root)).rejects.toThrow(
      'ReportsController is provided by Reports but not exported.',
    );
  });

  test('MODULES lists every module in initialization order, frozen', async () => {
    const ctx = await create(RefApp);
    expect(ctx.get(ModuleReport).describe()).toEqual([
      'GreetingModule (global): 0 controllers',
      'AppModule: 0 controllers',
    ]);
    expect(Object.isFrozen(ctx.get(MODULES))).toBe(true);
  });

  test('globalModules come first in MODULES', async () => {
    @Module({})
    class Extra {}
    const ctx = await create(RefApp, { globalModules: [Extra] });
    expect(ctx.modules.map((m) => m.name)).toEqual(['Extra', 'GreetingModule', 'AppModule']);
    expect(ctx.root.metatype).toBe(RefApp);
  });

  test('module definition errors', async () => {
    class NotAModule {}
    @Module({ imports: [NotAModule] })
    class A {}
    await expect(create(A)).rejects.toThrow(
      'A imports NotAModule, which is not a module. Did you forget @Module()?',
    );
    @Module({ exports: [Database] })
    class B {}
    await expect(create(B)).rejects.toThrow(
      'B exports Database, which it neither provides nor imports.',
    );
    const imports: never[] = [];
    @Module({ imports })
    class C {}
    @Module({ imports: [C] })
    class D {}
    imports.push(D as never);
    await expect(create(C)).rejects.toThrow('Circular module import: C → D → C');
    @Module({ imports: [undefined as never] })
    class E {}
    await expect(create(E)).rejects.toThrow(
      'E has undefined in imports at index 0. This usually means a circular file import; check the import order of your module files.',
    );
    await expect(create(undefined as never)).rejects.toThrow(
      'The root module is undefined. This usually means a circular file import; check the import order of your module files.',
    );
    @Module({ imports: [42 as never] })
    class F {}
    await expect(create(F)).rejects.toThrow(
      'F imports 42 at index 0, which is neither a module class nor a dynamic module.',
    );
    await expect(create(A)).rejects.toBeInstanceOf(ModuleDefinitionError);
  });
});

describe('guide/dependency-injection', () => {
  test('field initializers, constructors and optional injection', async () => {
    const ctx = await create(ShopModule);
    expect(ctx.get(CartService).total([150, 250])).toBe('$4.00');
    expect(ctx.get(InvoiceService).prefix).toBe('INV-USD');
    expect(ctx.get(CheckoutService).tracer).toBeUndefined();
    expect(ctx.get(CheckoutService).checkout()).toBe('ok');
  });

  test('provider forms', async () => {
    const ctx = await create(ProvidersApp);
    expect(ctx.get(Cache)).toBeInstanceOf(MemoryCache);
    expect(ctx.get(LEGACY_CACHE)).toBe(ctx.get(Cache));
    expect(ctx.get(CONNECTION_LABEL)).toBe('db at postgres://db.internal/app');
    expect(ctx.get(APP_CONFIG).port).toBe(3000);
    expect(ctx.get(PaymentsClient).apiKey).toBe('key-for-postgres://db.internal/app');
    expect(ctx.get(HealthService).report()).toEqual({ memory: true, cache: true });
  });

  test('transient providers: a new instance per injection', async () => {
    const ctx = await create(ProvidersApp);
    expect(ctx.get(AuditLog).ids).not.toBe(ctx.get(AccessLog).ids);
    expect(ctx.get(AuditLog)).toBe(ctx.get(AuditLog));
  });

  test('a later registration of the same token in one module replaces the earlier one', async () => {
    const T = new InjectionToken<string>('T');
    @Module({
      providers: [
        { provide: T, useValue: 'first' },
        { provide: T, useValue: 'second' },
      ],
    })
    class Root {}
    expect((await create(Root)).get(T)).toBe('second');
  });

  test('multi providers collect across own, imported and global modules', async () => {
    const PLUGINS = new InjectionToken<string[]>('PLUGINS');
    @Module({
      global: true,
      providers: [{ provide: PLUGINS, multi: true, useValue: 'global' }],
      exports: [PLUGINS],
    })
    class G {}
    @Module({
      providers: [{ provide: PLUGINS, multi: true, useValue: 'import' }],
      exports: [PLUGINS],
    })
    class I {}
    @Injectable()
    class Reader {
      readonly plugins = inject(PLUGINS);
    }
    @Module({
      imports: [I],
      providers: [Reader, { provide: PLUGINS, multi: true, useValue: 'own' }],
      exports: [Reader],
    })
    class Feature {}
    @Module({ imports: [G, Feature] })
    class Root {}
    const ctx = await create(Root);
    expect(ctx.get(Reader).plugins).toEqual(['own', 'import', 'global']);
    // collect() gathers every module's contributions in MODULES order, ignoring exports.
    expect(ctx.collect(PLUGINS)).toEqual(['global', 'import', 'own']);
  });

  test('mixing multi and non-multi in one module is a ProviderConfigError', async () => {
    const T = new InjectionToken<string[]>('LIST');
    @Module({
      providers: [
        { provide: T, multi: true, useValue: 'a' },
        { provide: T, useValue: ['b'] },
      ],
    })
    class Root {}
    await expect(create(Root)).rejects.toThrow(
      'LIST is registered in Root both with and without multi: true.',
    );
  });

  test('provider configuration errors', async () => {
    const T = new InjectionToken<string>('T');
    expect(() => normalizeProvider({ provide: T } as never)).toThrow(
      'Provider for T must define useClass, useValue, useFactory or useExisting.',
    );
    expect(() => normalizeProvider(42 as never)).toThrow(
      'Invalid provider: 42. Expected a class or an object with "provide".',
    );
    @Injectable()
    class UsesT {
      readonly t = inject(T);
    }
    @Module({
      providers: [UsesT, { provide: T, scope: 'transient', useFactory: async () => 'x' }],
    })
    class Root {}
    await expect(create(Root)).rejects.toThrow('Transient provider T cannot use an async factory.');
    await expect(create(Root)).rejects.toBeInstanceOf(ProviderConfigError);
  });

  test('inject() outside an injection context', async () => {
    expect(() => new BrokenReminderService().remindLater()).toThrow(
      'inject(CLOCK) was called outside an injection context. inject() only works synchronously inside field initializers, constructors and provider factories; call it before the first await.',
    );
    expect(insideInjectionContext()).toBe(false);
  });

  test('inject() before the first await works; after it, it throws', async () => {
    @Module({ providers: [{ provide: CLOCK, useValue: { now: () => 42 } }, startTimeProvider] })
    class Root {}
    expect((await create(Root)).get(START_TIME)).toBe(42);
    @Module({
      providers: [
        { provide: CLOCK, useValue: { now: () => 42 } },
        {
          provide: START_TIME,
          useFactory: async () => {
            await Bun.sleep(1);
            return inject(CLOCK).now();
          },
        },
      ],
    })
    class Late {}
    await expect(create(Late)).rejects.toBeInstanceOf(InjectionContextError);
  });

  test('runInInjectionContext with a module injector', async () => {
    @Module({ providers: [{ provide: CLOCK, useValue: { now: () => 1000 } }] })
    class Root {}
    const ctx = await create(Root);
    expect(buildReminderService(ctx).remindLater()).toBe(61_000);
  });

  test('async factories: code before the first await may run more than once', async () => {
    const A = new InjectionToken<string>('A');
    const B = new InjectionToken<string>('B');
    let aRuns = 0;
    @Module({
      providers: [
        {
          provide: A,
          useFactory: async () => {
            aRuns++;
            const b = inject(B);
            await Bun.sleep(1);
            return `a(${b})`;
          },
        },
        {
          provide: B,
          useFactory: async () => {
            await Bun.sleep(1);
            return 'b';
          },
        },
      ],
    })
    class Root {}
    const ctx = await create(Root);
    expect(ctx.get(A)).toBe('a(b)');
    expect(aRuns).toBe(2);
  });

  test('a rejecting async factory rejects create()', async () => {
    const T = new InjectionToken<string>('T');
    @Module({
      providers: [{ provide: T, useFactory: async () => Promise.reject(new Error('db down')) }],
    })
    class Root {}
    await expect(create(Root)).rejects.toThrow('db down');
  });

  test('every singleton is created at bootstrap; transients only when injected', async () => {
    let built = 0;
    @Injectable()
    class Eager {
      constructor() {
        built++;
      }
    }
    @Module({ providers: [Eager] })
    class Root {}
    await create(Root);
    expect(built).toBe(1);
    let transientBuilt = 0;
    const T = new InjectionToken<number>('T');
    @Module({
      providers: [{ provide: T, scope: 'transient', useFactory: () => ++transientBuilt }],
    })
    class Root2 {}
    const ctx = await create(Root2);
    expect(transientBuilt).toBe(0);
    expect(ctx.get(T)).toBe(1);
    expect(ctx.get(T)).toBe(2);
  });

  test('optional injection still throws errors from building a visible provider', async () => {
    @Injectable()
    class Broken {
      constructor() {
        throw new Error('broken');
      }
    }
    @Injectable()
    class Uses {
      readonly b = inject(Broken, { optional: true });
    }
    @Module({ providers: [Broken, Uses] })
    class Root {}
    await expect(create(Root)).rejects.toThrow('broken');
  });

  test('circular dependencies', async () => {
    await expect(create(CyclicModule)).rejects.toThrow(
      'Circular dependency detected: OrdersService → InvoicesService → OrdersService',
    );
    const error = await create(CyclicModule).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CircularDependencyError);
    expect((error as CircularDependencyError).path).toEqual([
      'OrdersService',
      'InvoicesService',
      'OrdersService',
    ]);
    expect(Orders).toBeDefined();
    expect(Invoices).toBeDefined();
  });

  test('NoProviderError without any provider', async () => {
    class Missing {}
    @Injectable()
    class Needs {
      readonly m = inject(Missing);
    }
    @Module({ providers: [Needs] })
    class Root {}
    await expect(create(Root)).rejects.toThrow(
      'Needs (Root) requested Missing, but no provider is visible. No module provides Missing. Add it to the providers of Root or of a module that Root imports.',
    );
  });

  test('ApplicationContext.get is not bound by exports', async () => {
    const ctx = await create(AppModule);
    expect(ctx.get(ConnectionPool)).toBeInstanceOf(ConnectionPool);
    const T = new InjectionToken<string>('NOPE');
    expect(() => ctx.get(T)).toThrow(
      'ApplicationContext (AppModule) requested NOPE, but no provider is visible.',
    );
  });

  test('overrides', async () => {
    const ctx = await createTestContext();
    contexts.push(ctx);
    const { CheckoutService: Checkout } = await import('../snippets/core/overrides.js');
    expect(ctx.get(Checkout).gateway.charge(5)).toBe('pretended to charge 5');
  });

  test('an override for a token no module registers has no effect', async () => {
    const T = new InjectionToken<string>('T');
    @Injectable()
    class Reader {
      readonly t = inject(T, { optional: true });
    }
    @Module({ providers: [Reader] })
    class Root {}
    const ctx = await create(Root, { overrides: [[T, { provide: T, useValue: 'x' }]] });
    expect(ctx.get(Reader).t).toBeUndefined();
  });

  test('overrides do not apply to multi providers', async () => {
    const LIST = new InjectionToken<string[]>('LIST');
    @Module({ providers: [{ provide: LIST, multi: true, useValue: 'real' }] })
    class Root {}
    const ctx = await create(Root, {
      overrides: [[LIST, { provide: LIST, useValue: ['fake'] }]],
    });
    expect(ctx.collect(LIST)).toEqual(['real']);
  });

  test('custom decorators with metadata', () => {
    expect(auditAction(InvoiceController, 'void')).toBe('invoice:invoice.void');
    expect(auditAction(InvoiceController, 'other')).toBeUndefined();
    class Sub extends InvoiceController {}
    expect(auditAction(Sub, 'void')).toBeUndefined();
  });

  test('tokens and errors', () => {
    const T = new InjectionToken<string>('T');
    expect(String(T)).toBe('InjectionToken(T)');
    expect(tokenName(T)).toBe('T');
    expect(tokenName(class Named {})).toBe('Named');
    expect(new NoProviderError('x').name).toBe('NoProviderError');
    expect(new ModuleDefinitionError('x')).toBeInstanceOf(KneadError);
  });
});

describe('guide/lifecycle', () => {
  test('init in dependency order; shutdown in reverse; signal passed', async () => {
    const ctx = await ApplicationContext.create(WorkerModule, { logger: new MemoryLogger() });
    const events = ctx.get(EVENTS);
    expect(events).toEqual([
      'Database.onModuleInit',
      'JobRunner.onApplicationBootstrap connected=true',
    ]);
    await Promise.all([ctx.close('SIGTERM'), ctx.close('SIGTERM')]);
    expect(events.slice(2)).toEqual([
      'JobRunner.beforeApplicationShutdown SIGTERM',
      'Database.onModuleDestroy',
    ]);
    expect(ctx.get(LifecycleDb).connected).toBe(false);
    expect(ctx.closed).toBe(true);
  });

  test('all onModuleInit run before any onApplicationBootstrap', async () => {
    const log: string[] = [];
    @Injectable()
    class A {
      onModuleInit() {
        log.push('a:init');
      }
      onApplicationBootstrap() {
        log.push('a:bootstrap');
      }
    }
    @Injectable()
    class B {
      readonly a = inject(A);
      onModuleInit() {
        log.push('b:init');
      }
      onApplicationBootstrap() {
        log.push('b:bootstrap');
      }
      beforeApplicationShutdown() {
        log.push('b:before');
      }
      onModuleDestroy() {
        log.push('b:destroy');
      }
    }
    @Injectable()
    class C {
      beforeApplicationShutdown() {
        log.push('c:before');
      }
      onModuleDestroy() {
        log.push('c:destroy');
      }
    }
    @Module({ providers: [B, A, C] })
    class Root {}
    const ctx = await ApplicationContext.create(Root, { logger: new MemoryLogger() });
    expect(log).toEqual(['a:init', 'b:init', 'a:bootstrap', 'b:bootstrap']);
    log.length = 0;
    await ctx.close();
    expect(log).toEqual(['c:before', 'b:before', 'c:destroy', 'b:destroy']);
  });

  test('useValue objects get no hooks; factory results and transients built at bootstrap do', async () => {
    const log: string[] = [];
    const VALUE = new InjectionToken<object>('VALUE');
    const MADE = new InjectionToken<object>('MADE');
    @Injectable()
    class Hooked {
      onModuleInit() {
        log.push('transient');
      }
    }
    @Injectable()
    class Uses {
      readonly h = inject(Hooked);
    }
    @Module({
      providers: [
        { provide: VALUE, useValue: { onModuleInit: () => log.push('value') } },
        { provide: MADE, useFactory: () => ({ onModuleInit: () => log.push('factory') }) },
        { provide: Hooked, useClass: Hooked, scope: 'transient' },
        Uses,
      ],
    })
    class Root {}
    const ctx = await create(Root);
    expect(log.sort()).toEqual(['factory', 'transient']);
    log.length = 0;
    ctx.get(Hooked);
    await ctx.close();
    expect(log).toEqual([]);
  });

  test('a failing onModuleInit closes what was initialized and rethrows', async () => {
    const log: string[] = [];
    const boom = new Error('init failed');
    @Injectable()
    class A {
      onModuleInit() {
        log.push('a:init');
      }
      onModuleDestroy() {
        log.push('a:destroy');
      }
    }
    @Injectable()
    class B {
      readonly a = inject(A);
      onModuleInit() {
        throw boom;
      }
      onModuleDestroy() {
        log.push('b:destroy');
      }
    }
    @Module({ providers: [A, B] })
    class Root {}
    await expect(ApplicationContext.create(Root)).rejects.toBe(boom);
    expect(log).toEqual(['a:init', 'a:destroy']);
  });

  test('a failing onApplicationBootstrap shuts every initialized instance down', async () => {
    const log: string[] = [];
    @Injectable()
    class A {
      onApplicationBootstrap() {
        throw new Error('bootstrap failed');
      }
      onModuleDestroy() {
        log.push('a:destroy');
      }
    }
    @Injectable()
    class B {
      onModuleDestroy() {
        log.push('b:destroy');
      }
    }
    @Module({ providers: [A, B] })
    class Root {}
    await expect(ApplicationContext.create(Root)).rejects.toThrow('bootstrap failed');
    expect(log).toEqual(['b:destroy', 'a:destroy']);
  });

  test('shutdown errors: every hook runs, one error rethrown, several aggregated', async () => {
    const log: string[] = [];
    @Injectable()
    class A {
      onModuleDestroy() {
        throw new Error('a');
      }
    }
    @Injectable()
    class B {
      onModuleDestroy() {
        log.push('b');
        throw new Error('b');
      }
    }
    @Module({ providers: [A, B] })
    class Root {}
    const ctx = await ApplicationContext.create(Root);
    const error = await ctx.close().catch((e: unknown) => e);
    expect(log).toEqual(['b']);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe('Application shutdown failed');
    @Module({ providers: [A] })
    class One {}
    const one = await ApplicationContext.create(One);
    await expect(one.close()).rejects.toThrow('a');
  });

  test('standalone context runs and closes', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    try {
      expect(await runReport()).toEqual(['report: 3 overdue invoices']);
      expect(info.mock.calls).toEqual([['[knead] stopping jobs (no signal)']]);
    } finally {
      info.mockRestore();
    }
  });

  test('default LOGGER and DEVELOPMENT', async () => {
    const original = process.env.NODE_ENV;
    const info = spyOn(console, 'info').mockImplementation(() => {});
    try {
      process.env.NODE_ENV = 'production';
      const ctx = await ApplicationContext.create(ReportModule);
      expect(ctx.get(LOGGER)).toBeInstanceOf(ConsoleLogger);
      expect(ctx.get(DEVELOPMENT)).toBe(false);
      await ctx.close();
      const dev = await create(ReportModule, { development: true });
      expect(dev.get(DEVELOPMENT)).toBe(true);
    } finally {
      info.mockRestore();
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });
});

describe('packages/core logging exports', () => {
  test('logError in production logs Name: message, redacted, with a correlation id', async () => {
    const logger = new MemoryLogger();
    const ctx = await create(CacheModule, { logger, development: false });
    const id = await ctx.get(CacheWarmer).warm(['user:1\n'], async () => {
      throw new Error('connect redis://cache:hunter2@cache.internal:6379 refused');
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(logger.entries).toEqual([
      {
        level: 'info',
        message: 'warming 1 keys from redis://***@cache.internal:6379',
        meta: [],
      },
      {
        level: 'warn',
        message: `Warming user:1\\n failed (correlation id ${id}): Error: connect redis://***@cache.internal:6379 refused`,
        meta: [],
      },
    ]);
  });

  test('logError in development logs the redacted error as meta', async () => {
    const logger = new MemoryLogger();
    const ctx = await create(CacheModule, { logger, development: true });
    const id = await ctx.get(CacheWarmer).warm(['k'], async () => {
      throw new Error('plain failure');
    });
    const entry = logger.entries[1]!;
    expect(entry.message).toBe(`Warming k failed (correlation id ${id})`);
    expect(entry.meta[0]).toBeInstanceOf(Error);
  });

  test('redactCredentials', () => {
    expect(redactCredentials('redis://user:pass@host:6379/0')).toBe('redis://***@host:6379/0');
    expect(redactCredentials('https://example.com/users/@ada')).toBe(
      'https://example.com/users/@ada',
    );
    expect(redactCredentials('?access_token=abc&page=2')).toBe('?access_token=***&page=2');
    expect(redactCredentials('DB_PASSWORD=s3cret other')).toBe('DB_PASSWORD=*** other');
    expect(redactCredentials('Authorization: Bearer abcdefgh12345')).toBe(
      'Authorization: Bearer ***',
    );
    expect(redactCredentials('Bearer abc123')).toBe('Bearer abc123');
    expect(redactCredentials('Basic user:pass')).toBe('Basic ***');
  });

  test('redactValue', () => {
    const input = {
      headers: { authorization: 'Bearer x', 'x-api-key': 'k' },
      maxTokens: 100,
      url: 'postgres://u:p@db/app',
    };
    expect(redactValue(input)).toEqual({
      headers: { authorization: '***', 'x-api-key': '***' },
      maxTokens: 100,
      url: 'postgres://***@db/app',
    });
    expect(input.headers.authorization).toBe('Bearer x');
    const plain = { a: 1 };
    expect(redactValue(plain)).toBe(plain);
    const cyclic: Record<string, unknown> = { password: 'p' };
    cyclic.self = cyclic;
    expect(redactValue(cyclic)).toEqual({ password: '***', self: '[Circular]' });
    expect(redactValue({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({
      a: { b: { c: { d: '[Object]' } } },
    });
    expect(redactValue(new Map([['token', 'abc']]))).toEqual({ token: '***' });
    const error = new Error('failed for redis://u:p@h');
    const redacted = redactValue(error);
    expect(typeof redacted).toBe('string');
    expect(String(redacted)).toStartWith('Error: failed for redis://***@h');
    const clean = new Error('fine');
    expect(redactValue(clean)).toBe(clean);
  });

  test('summarizeError, logValue, escapeControl and limits', () => {
    expect(summarizeError(new TypeError('bad\nline'))).toBe('TypeError: bad\\nline');
    expect(summarizeError('oops')).toBe('string: oops');
    expect(summarizeError({ message: 'm' })).toBe('Error: m');
    expect(summarizeError(new Error('x'.repeat(600)))).toBe(`Error: ${'x'.repeat(500)}…`);
    expect(LOGGED_MESSAGE_LENGTH).toBe(500);
    expect(MAX_LOGGED_VALUE_LENGTH).toBe(1024);
    expect(logValue('a'.repeat(1030))).toBe(`${'a'.repeat(1024)}…`);
    expect(escapeControl('a\r\nb\t\u001b[31m')).toBe('a\\r\\nb\\t\\x1b[31m');
  });

  test('ConsoleLogger prefixes, redacts and escapes', () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    try {
      new ConsoleLogger().info('to redis://u:p@h\nforged', 'k=v token=abc', { password: 'p' });
      expect(info.mock.calls[0]).toEqual([
        '[knead] to redis://***@h\\nforged',
        'k=v token=***',
        { password: '***' },
      ]);
      new ConsoleLogger('worker').info('hi');
      expect(info.mock.calls[1]).toEqual(['[worker] hi']);
    } finally {
      info.mockRestore();
    }
  });

  test('MemoryLogger keeps entries unredacted', () => {
    const logger = new MemoryLogger();
    logger.error('redis://u:p@h', { password: 'p' });
    expect(logger.entries).toEqual([
      { level: 'error', message: 'redis://u:p@h', meta: [{ password: 'p' }] },
    ]);
    logger.clear();
    expect(logger.entries).toEqual([]);
  });
});

describe('packages/core net helpers', () => {
  test('parseIp, isLoopbackHostname, plaintextRedisHost, defaultRedisUrl', () => {
    expect([...parseIp('::ffff:10.0.0.1')!]).toEqual([10, 0, 0, 1]);
    expect(parseIp('::1')?.length).toBe(16);
    expect(parseIp('300.1.1.1')).toBeUndefined();
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('127.8.0.1')).toBe(true);
    expect(isLoopbackHostname('localhost.example')).toBe(false);
    expect(plaintextRedisHost('redis://u:p@cache.internal:6379')).toBe('cache.internal:6379');
    expect(plaintextRedisHost('rediss://cache.internal')).toBeUndefined();
    expect(plaintextRedisHost('redis://localhost')).toBeUndefined();
    const saved = { REDIS_URL: process.env.REDIS_URL, VALKEY_URL: process.env.VALKEY_URL };
    try {
      process.env.REDIS_URL = '';
      process.env.VALKEY_URL = 'valkey://v';
      expect(defaultRedisUrl()).toBe('valkey://v');
      delete process.env.VALKEY_URL;
      expect(defaultRedisUrl()).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
