import { describe, expect, test } from 'bun:test';
import {
  InjectionToken,
  inject,
  Module,
  ModuleDefinitionError,
  NoProviderError,
} from '../src/index.js';
import { ContainerState } from '../src/injector.js';
import { buildModuleGraph } from '../src/modules.js';

function build(
  root: Parameters<typeof buildModuleGraph>[0],
  globals: Parameters<typeof buildModuleGraph>[1] = [],
) {
  return buildModuleGraph(root, globals, new ContainerState());
}

class DbService {}
class UsersService {
  readonly db = inject(DbService);
}
class UsersController {
  readonly users = inject(UsersService);
}

describe('encapsulation', () => {
  test('exported providers are visible to importers', () => {
    @Module({ providers: [DbService], exports: [DbService] })
    class DbModule {}
    @Module({ imports: [DbModule], providers: [UsersService] })
    class UsersModule {}
    const { root } = build(UsersModule);
    expect(root.injector.get(UsersService)!.db).toBeInstanceOf(DbService);
  });

  test('non-exported providers are invisible, with a hint', () => {
    @Module({ providers: [DbService] })
    class DbModule {}
    @Module({ imports: [DbModule], providers: [UsersService], controllers: [UsersController] })
    class UsersModule {}
    const { root } = build(UsersModule);
    expect(() => root.injector.get(UsersController)).toThrow(NoProviderError);
    expect(() => root.injector.get(UsersService)).toThrow(
      'UsersService (UsersModule) requested DbService, but no provider is visible. DbService is provided by DbModule but not exported.',
    );
  });

  test('exported but not imported gives an import hint', () => {
    @Module({ providers: [DbService], exports: [DbService] })
    class DbModule {}
    @Module({ providers: [UsersService] })
    class UsersModule {}
    @Module({ imports: [DbModule, UsersModule] })
    class AppModule {}
    const { modules } = build(AppModule);
    const users = modules.find((m) => m.name === 'UsersModule')!;
    expect(() => users.injector.get(UsersService)).toThrow(
      'DbService is exported by DbModule; add DbModule to the imports of UsersModule.',
    );
  });

  test('providers are not visible transitively without re-export', () => {
    @Module({ providers: [DbService], exports: [DbService] })
    class DbModule {}
    @Module({ imports: [DbModule] })
    class MiddleModule {}
    @Module({ imports: [MiddleModule], providers: [UsersService] })
    class TopModule {}
    expect(() => build(TopModule).root.injector.get(UsersService)).toThrow(NoProviderError);
  });

  test('re-exporting an imported module exposes its exports', () => {
    @Module({ providers: [DbService], exports: [DbService] })
    class DbModule {}
    @Module({ imports: [DbModule], exports: [DbModule] })
    class MiddleModule {}
    @Module({ imports: [MiddleModule], providers: [UsersService] })
    class TopModule {}
    const { root, modules } = build(TopModule);
    const db = modules.find((m) => m.name === 'DbModule')!.injector.get(DbService);
    expect(root.injector.get(UsersService)!.db).toBe(db!);
  });

  test('global modules are visible everywhere without importing', () => {
    @Module({ providers: [DbService], exports: [DbService], global: true })
    class DbModule {}
    @Module({ providers: [UsersService] })
    class UsersModule {}
    @Module({ imports: [DbModule, UsersModule] })
    class AppModule {}
    const users = build(AppModule).modules.find((m) => m.name === 'UsersModule')!;
    expect(users.injector.get(UsersService)!.db).toBeInstanceOf(DbService);
  });

  test('extra global modules passed to the builder are visible', () => {
    const TOKEN = new InjectionToken<string>('TOKEN');
    @Module({})
    class Core {}
    class NeedsToken {
      readonly value = inject(TOKEN);
    }
    @Module({ providers: [NeedsToken] })
    class AppModule {}
    const { root } = build(AppModule, [
      {
        module: Core,
        global: true,
        providers: [{ provide: TOKEN, useValue: 'x' }],
        exports: [TOKEN],
      },
    ]);
    expect(root.injector.get(NeedsToken)!.value).toBe('x');
  });
});

describe('graph shape', () => {
  test('a module imported twice is instantiated once', () => {
    @Module({ providers: [DbService], exports: [DbService] })
    class DbModule {}
    @Module({ imports: [DbModule], exports: [DbModule] })
    class A {}
    @Module({ imports: [DbModule], exports: [DbModule] })
    class B {}
    @Module({ imports: [A, B] })
    class AppModule {}
    const { modules } = build(AppModule);
    expect(modules.filter((m) => m.name === 'DbModule')).toHaveLength(1);
    expect(modules.map((m) => m.name)).toEqual(['DbModule', 'A', 'B', 'AppModule']);
  });

  test('dynamic modules merge with static @Module options', () => {
    const OPTIONS = new InjectionToken<{ level: number }>('OPTIONS');
    @Module({ providers: [DbService], exports: [DbService] })
    class ConfigModule {
      static forRoot(level: number) {
        return {
          module: ConfigModule,
          providers: [{ provide: OPTIONS, useValue: { level } }],
          exports: [OPTIONS],
        };
      }
    }
    @Module({ imports: [ConfigModule.forRoot(3)] })
    class AppModule {}
    const { root } = build(AppModule);
    expect(root.injector.get(OPTIONS)).toEqual({ level: 3 });
    expect(root.injector.get(DbService)).toBeInstanceOf(DbService);
  });

  test('a dynamic module whose class has no @Module is allowed', () => {
    class Bare {}
    const { root } = build({ module: Bare, providers: [DbService] });
    expect(root.injector.get(DbService)).toBeInstanceOf(DbService);
    expect(root.name).toBe('Bare');
  });

  test('controllers are registered as module-local providers', () => {
    class C {}
    @Module({ controllers: [C] })
    class M {}
    const { root } = build(M);
    expect(root.controllers).toEqual([C]);
    expect(root.injector.get(C)).toBeInstanceOf(C);
  });
});

describe('dynamic variants', () => {
  test('re-exporting a class re-exports every dynamic variant', () => {
    const A = new InjectionToken<string>('A');
    const B = new InjectionToken<string>('B');
    @Module({})
    class FeatureModule {
      static forFeature(token: InjectionToken<string>, value: string) {
        return {
          module: FeatureModule,
          providers: [{ provide: token, useValue: value }],
          exports: [token],
        };
      }
    }
    @Module({
      imports: [FeatureModule.forFeature(A, 'a'), FeatureModule.forFeature(B, 'b')],
      exports: [FeatureModule],
    })
    class MiddleModule {}
    class Consumer {
      readonly a = inject(A);
      readonly b = inject(B);
    }
    @Module({ imports: [MiddleModule], providers: [Consumer] })
    class AppModule {}
    const c = build(AppModule).root.injector.get(Consumer)!;
    expect([c.a, c.b]).toEqual(['a', 'b']);
  });
});

describe('dynamic variant export selection', () => {
  const A = new InjectionToken<string>('A');
  const B = new InjectionToken<string>('B');
  @Module({ providers: [{ provide: A, useValue: 'a' }], exports: [A] })
  class ConfigModule {
    static forFeature(value: string) {
      return { module: ConfigModule, providers: [{ provide: B, useValue: value }], exports: [B] };
    }
  }
  class Consumer {
    readonly a = inject(A);
    readonly b = inject(B);
  }

  test('class export covers a plain import and dynamic variants of the same class', () => {
    @Module({ imports: [ConfigModule, ConfigModule.forFeature('b')], exports: [ConfigModule] })
    class MiddleModule {}
    @Module({ imports: [MiddleModule], providers: [Consumer] })
    class AppModule {}
    const c = build(AppModule).root.injector.get(Consumer)!;
    expect([c.a, c.b]).toEqual(['a', 'b']);
  });

  test('exporting a dynamic module object selects only that variant', () => {
    class OnlyB {
      readonly b = inject(B);
    }
    class NeedsOther {
      readonly b = inject(C);
    }
    const C = new InjectionToken<string>('C');
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
    const vb = Feature.of(B, 'b');
    const vc = Feature.of(C, 'c');
    @Module({ imports: [vb, vc], exports: [vb] })
    class MiddleModule {}
    @Module({ imports: [MiddleModule], providers: [OnlyB, NeedsOther] })
    class AppModule {}
    const { root } = build(AppModule);
    expect(root.injector.get(OnlyB)!.b).toBe('b');
    expect(() => root.injector.get(NeedsOther)).toThrow(NoProviderError);
  });
});

describe('definition errors', () => {
  test('an undefined root module is reported clearly', () => {
    expect(() => buildModuleGraph(undefined as never, [], new ContainerState())).toThrow(
      'The root module is undefined. This usually means a circular file import; check the import order of your module files.',
    );
  });

  test('undefined imports point at circular file imports', () => {
    @Module({ imports: [undefined as never] })
    class AppModule {}
    expect(() => build(AppModule)).toThrow(ModuleDefinitionError);
    expect(() => build(AppModule)).toThrow(/AppModule has undefined in imports at index 0/);
  });

  test('importing a plain class is rejected', () => {
    class NotAModule {}
    @Module({ imports: [NotAModule] })
    class AppModule {}
    expect(() => build(AppModule)).toThrow(
      'AppModule imports NotAModule, which is not a module. Did you forget @Module()?',
    );
  });

  test('circular module imports are rejected with the path', () => {
    const imports: unknown[] = [];
    @Module({ imports: imports as never })
    class A {}
    @Module({ imports: [A] })
    class B {}
    imports.push(B);
    expect(() => build(A)).toThrow('Circular module import: A → B → A');
  });

  test('exporting something neither provided nor imported is rejected', () => {
    @Module({ exports: [DbService] })
    class M {}
    expect(() => build(M)).toThrow('M exports DbService, which it neither provides nor imports.');
  });
});
