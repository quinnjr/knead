import { describe, expect, test } from 'bun:test';
import {
  ApplicationContext,
  type BeforeApplicationShutdown,
  InjectionToken,
  inject,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '../src/index.js';

describe('lifecycle hooks', () => {
  test('init in dependency order, shutdown in reverse; close is idempotent', async () => {
    const log: string[] = [];
    class Db
      implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown, OnModuleDestroy
    {
      async onModuleInit() {
        await Promise.resolve();
        log.push('db:init');
      }
      onApplicationBootstrap() {
        log.push('db:bootstrap');
      }
      beforeApplicationShutdown(signal?: string) {
        log.push(`db:before(${signal})`);
      }
      onModuleDestroy() {
        log.push('db:destroy');
      }
    }
    class Users
      implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown, OnModuleDestroy
    {
      readonly db = inject(Db);
      onModuleInit() {
        log.push('users:init');
      }
      onApplicationBootstrap() {
        log.push('users:bootstrap');
      }
      beforeApplicationShutdown(signal?: string) {
        log.push(`users:before(${signal})`);
      }
      onModuleDestroy() {
        log.push('users:destroy');
      }
    }
    @Module({ providers: [Users, Db] })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    expect(log).toEqual(['db:init', 'users:init', 'db:bootstrap', 'users:bootstrap']);
    log.length = 0;
    await Promise.all([ctx.close('SIGTERM'), ctx.close('SIGTERM')]);
    expect(log).toEqual([
      'users:before(SIGTERM)',
      'db:before(SIGTERM)',
      'users:destroy',
      'db:destroy',
    ]);
  });

  test('useValue objects do not receive hooks; factory results do', async () => {
    const log: string[] = [];
    const VALUE = new InjectionToken<object>('VALUE');
    const MADE = new InjectionToken<object>('MADE');
    @Module({
      providers: [
        { provide: VALUE, useValue: { onModuleInit: () => log.push('value') } },
        { provide: MADE, useFactory: () => ({ onModuleInit: () => log.push('factory') }) },
      ],
    })
    class AppModule {}
    await ApplicationContext.create(AppModule);
    expect(log).toEqual(['factory']);
  });
});

describe('overrides', () => {
  test('replace providers by token', async () => {
    class Mailer {
      send() {
        return 'real';
      }
    }
    class Signup {
      readonly mailer = inject(Mailer);
    }
    @Module({ providers: [Mailer, Signup] })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule, {
      overrides: [[Mailer, { provide: Mailer, useValue: { send: () => 'fake' } }]],
    });
    expect(ctx.get(Signup).mailer.send()).toBe('fake');
  });
});

describe('resolveOrConstruct', () => {
  class Clock {
    now() {
      return 1;
    }
  }
  class Guard {
    readonly clock = inject(Clock);
  }

  test('constructs unregistered classes once per module with injection', async () => {
    @Module({ providers: [Clock] })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    const a = ctx.root.injector.resolveOrConstruct(Guard);
    expect(a.clock).toBe(ctx.get(Clock));
    expect(ctx.root.injector.resolveOrConstruct(Guard)).toBe(a);
  });

  test('returns the registered provider when visible', async () => {
    @Module({ providers: [Clock, Guard] })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    expect(ctx.root.injector.resolveOrConstruct(Guard)).toBe(ctx.get(Guard));
  });

  test('honours overrides for unregistered classes', async () => {
    @Module({ providers: [Clock] })
    class AppModule {}
    const fake = { clock: null };
    const ctx = await ApplicationContext.create(AppModule, {
      overrides: [[Guard, { provide: Guard, useValue: fake }]],
    });
    expect(ctx.root.injector.resolveOrConstruct(Guard)).toBe(fake as never);
  });
});

describe('lifecycle robustness', () => {
  test('instances constructed after create() are not shut down', async () => {
    const log: string[] = [];
    class Late {
      onModuleDestroy() {
        log.push('late:destroy');
      }
    }
    class Svc {
      onModuleDestroy() {
        log.push('svc:destroy');
      }
    }
    @Module({ providers: [Svc] })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    ctx.root.injector.resolveOrConstruct(Late);
    await ctx.close();
    expect(log).toEqual(['svc:destroy']);
  });

  test('a throwing shutdown hook does not skip the rest; close rejects with the error', async () => {
    const log: string[] = [];
    const boom = new Error('boom');
    class A {
      beforeApplicationShutdown() {
        throw boom;
      }
      onModuleDestroy() {
        log.push('a:destroy');
      }
    }
    class B {
      beforeApplicationShutdown() {
        log.push('b:before');
      }
      onModuleDestroy() {
        log.push('b:destroy');
      }
    }
    @Module({ providers: [A, B] })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    const first = ctx.close();
    expect(ctx.close()).toBe(first);
    await expect(first).rejects.toBe(boom);
    expect(log).toEqual(['b:before', 'b:destroy', 'a:destroy']);
  });

  test('several shutdown errors are aggregated', async () => {
    class A {
      onModuleDestroy() {
        throw new Error('a');
      }
    }
    class B {
      onModuleDestroy() {
        throw new Error('b');
      }
    }
    @Module({ providers: [A, B] })
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    const err = await ctx.close().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toHaveLength(2);
  });

  test('failed bootstrap shuts down already-initialized instances', async () => {
    const log: string[] = [];
    const boom = new Error('init failed');
    class A {
      onModuleInit() {
        log.push('a:init');
      }
      onModuleDestroy() {
        log.push('a:destroy');
      }
    }
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
    class AppModule {}
    await expect(ApplicationContext.create(AppModule)).rejects.toBe(boom);
    expect(log).toEqual(['a:init', 'a:destroy']);
  });

  test('failed bootstrap rethrows the original error even if cleanup throws', async () => {
    const log: string[] = [];
    const boom = new Error('boom');
    class A {
      onModuleDestroy() {
        log.push('a:destroy');
        throw new Error('cleanup failed');
      }
    }
    class B {
      readonly a = inject(A);
      onModuleInit() {
        throw boom;
      }
    }
    @Module({ providers: [A, B] })
    class AppModule {}
    await expect(ApplicationContext.create(AppModule)).rejects.toBe(boom);
    expect(log).toEqual(['a:destroy']);
  });
});
