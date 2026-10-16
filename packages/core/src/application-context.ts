import type { ModuleImport } from './decorators.js';
import { ContainerState, ModuleInjector } from './injector.js';
import { buildModuleGraph, MODULES, type ModuleRef } from './modules.js';
import type { Provider } from './providers.js';
import type { Token } from './tokens.js';

export interface CreateContextOptions {
  /** Replace providers by token (used by @hpmws/testing). Applies to non-multi providers. */
  overrides?: Iterable<readonly [Token, Provider]>;
  /** Extra modules scanned before the root (e.g. framework core modules). */
  globalModules?: readonly ModuleImport[];
}

export class ApplicationContext {
  #closing: Promise<void> | undefined;
  /** Instances whose init hooks ran; only these receive shutdown hooks. */
  #initialized: object[] = [];
  /** Instances whose init hooks were attempted (create or initializeLate). */
  readonly #seen = new WeakSet<object>();

  private constructor(
    readonly modules: readonly ModuleRef[],
    readonly root: ModuleRef,
    private readonly state: ContainerState,
  ) {}

  static async create(
    root: ModuleImport,
    options: CreateContextOptions = {},
  ): Promise<ApplicationContext> {
    const state = new ContainerState(options.overrides);
    const graph = buildModuleGraph(root, options.globalModules ?? [], state);
    // MODULES is visible from every module: a synthetic global injector owns and exports it.
    const own = new ModuleInjector('ApplicationContext', state);
    own.addProvider({
      kind: 'value',
      token: MODULES,
      value: Object.freeze([...graph.modules]),
      scope: 'singleton',
      multi: false,
    });
    own.exported.set(MODULES, own);
    state.globals = [...state.globals, own];

    // Phase A: settle every singleton factory (async ones are awaited, dependents retried).
    for (const m of graph.modules) {
      for (const record of [...m.injector.ownRecords()]) {
        if (record.provider.kind === 'factory' && record.provider.scope === 'singleton') {
          await state.resolveAsync(record);
        }
      }
    }
    // Phase B: eagerly instantiate every remaining singleton so errors surface at bootstrap.
    for (const m of graph.modules) {
      for (const record of [...m.injector.ownRecords()]) {
        if (record.provider.scope === 'singleton') state.resolve(record);
      }
    }
    const context = new ApplicationContext(graph.modules, graph.root, state);
    await context.#initializePending();
    return context;
  }

  /**
   * @internal Runs onModuleInit then onApplicationBootstrap on instances constructed since
   * create() (e.g. middleware, guards and filters built lazily at listen()), so they also receive
   * shutdown hooks. Like create(), a failing hook closes the context and rethrows.
   */
  initializeLate(): Promise<void> {
    return this.#initializePending();
  }

  async #initializePending(): Promise<void> {
    const pending = (this.state.instances as object[]).filter((i) => !this.#seen.has(i));
    for (const instance of pending) this.#seen.add(instance);
    const initialized: object[] = [];
    try {
      for (const instance of pending) {
        await ApplicationContext.#call(instance, 'onModuleInit');
        this.#initialized.push(instance);
        initialized.push(instance);
      }
      for (const instance of initialized) {
        await ApplicationContext.#call(instance, 'onApplicationBootstrap');
      }
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  get<T>(token: Token<T>): T {
    const visible = this.root.injector.lookup(token);
    if (visible) return this.root.injector.get(token) as T;
    for (const m of this.modules) {
      if (m.injector.records.has(token)) return m.injector.get(token) as T;
    }
    throw this.root.injector.noProvider(token);
  }

  collect<T>(token: Token<T[]>): T[] {
    return this.collectEntries(token).map((e) => e.value);
  }

  /** Like collect, but pairs each contribution with the injector of the module that provides it. */
  collectEntries<T>(token: Token<T[]>): { value: T; injector: ModuleInjector }[] {
    const out: { value: T; injector: ModuleInjector }[] = [];
    for (const m of this.modules) {
      for (const record of m.injector.records.get(token) ?? [])
        out.push({ value: this.state.resolve(record) as T, injector: m.injector });
    }
    return out;
  }

  /** True once close() has started (including a close triggered by a failed init hook). */
  get closed(): boolean {
    return this.#closing !== undefined;
  }

  /** Runs shutdown hooks once, in reverse initialization order; hook errors are collected. */
  close(signal?: string): Promise<void> {
    this.#closing ??= (async () => {
      const errors: unknown[] = [];
      const reversed = [...this.#initialized].reverse();
      for (const [name, arg] of [
        ['beforeApplicationShutdown', signal],
        ['onModuleDestroy', undefined],
      ] as const) {
        for (const instance of reversed) {
          try {
            await ApplicationContext.#call(instance, name, arg);
          } catch (error) {
            errors.push(error);
          }
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Application shutdown failed');
    })();
    return this.#closing;
  }

  static async #call(instance: object, name: string, arg?: unknown): Promise<void> {
    const fn = (instance as Record<string, unknown>)[name];
    if (typeof fn === 'function') await fn.call(instance, arg);
  }
}
