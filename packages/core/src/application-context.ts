import type { ModuleImport } from './decorators.js';
import { KneadError } from './errors.js';
import { ContainerState, ModuleInjector } from './injector.js';
import { ConsoleLogger, LOGGER, type Logger } from './logger.js';
import { buildModuleGraph, MODULES, type ModuleRef } from './modules.js';
import type { Provider } from './providers.js';
import { DEVELOPMENT, type Token } from './tokens.js';

export interface CreateContextOptions {
  /** Replace providers by token (used by @knead-js/testing). Applies to non-multi providers. */
  overrides?: Iterable<readonly [Token, Provider]>;
  /** Extra modules scanned before the root (e.g. framework core modules). */
  globalModules?: readonly ModuleImport[];
  /** The LOGGER used unless a global module provides one. Default: a ConsoleLogger. */
  logger?: Logger;
  /** The DEVELOPMENT flag. Default: `NODE_ENV === 'development'`. */
  development?: boolean;
}

export class ApplicationContext {
  #closing: Promise<void> | undefined;
  /** The signal close() was called with, for instances initialized after it started. */
  #closeSignal: string | undefined;
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
    if (options.development !== undefined && typeof options.development !== 'boolean') {
      throw new KneadError(
        `The development option must be a boolean, got ${typeof options.development}.`,
      );
    }
    const state = new ContainerState(options.overrides);
    const graph = buildModuleGraph(root, options.globalModules ?? [], state);
    // MODULES is visible from every module: a synthetic global injector owns and exports it.
    const own = new ModuleInjector('ApplicationContext', state);
    const modules = Object.freeze([...graph.modules]);
    own.addProvider({
      kind: 'value',
      token: MODULES,
      value: modules,
      scope: 'singleton',
      multi: false,
    });
    own.exported.set(MODULES, [own]);
    // Defaults for LOGGER and DEVELOPMENT. `own` comes last in the globals, so a global module's
    // own registration (e.g. the HTTP core module) wins.
    own.addProvider({
      kind: 'value',
      token: LOGGER,
      value: options.logger ?? new ConsoleLogger(),
      scope: 'singleton',
      multi: false,
    });
    own.exported.set(LOGGER, [own]);
    own.addProvider({
      kind: 'value',
      token: DEVELOPMENT,
      value: options.development ?? process.env.NODE_ENV === 'development',
      scope: 'singleton',
      multi: false,
    });
    own.exported.set(DEVELOPMENT, [own]);
    state.globals = [...state.globals, own];

    // Phase A: settle every singleton factory (async ones are awaited, dependents retried),
    // including overrides of LOGGER and DEVELOPMENT held by `own` (last in state.injectors).
    for (const injector of state.injectors) {
      for (const record of [...injector.ownRecords()]) {
        if (record.provider.kind === 'factory' && record.provider.scope === 'singleton') {
          await state.resolveAsync(record);
        }
      }
    }
    // Phase B: eagerly instantiate every remaining singleton so errors surface at bootstrap.
    for (const injector of state.injectors) {
      for (const record of [...injector.ownRecords()]) {
        if (record.provider.scope === 'singleton') state.resolve(record);
      }
    }
    const context = new ApplicationContext(modules, graph.root, state);
    await context.#initializePending();
    state.endBootstrap();
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

  /**
   * @internal Runs `fn` with every instance it constructs tracked, transients included, as during
   * create(), so a following initializeLate() gives them lifecycle hooks. HttpApplication.listen()
   * builds its middleware, guards and filters inside it.
   */
  trackConstructed<T>(fn: () => T): T {
    return this.state.trackAll(fn);
  }

  async #initializePending(): Promise<void> {
    // Instances constructed after close() started never receive hooks.
    if (this.closed) return;
    try {
      await this.#runInitHooks();
    } catch (error) {
      try {
        await this.close();
      } catch (shutdownError) {
        ApplicationContext.#attachShutdownError(error, shutdownError);
      }
      throw error;
    }
  }

  /**
   * onModuleInit then onApplicationBootstrap on the instances not seen yet. Starts no hook once
   * close() has begun. close() does not wait for a hook in progress (it may be awaiting close()
   * itself), so an instance whose onModuleInit completes after close() started receives its
   * shutdown hooks here instead.
   */
  async #runInitHooks(): Promise<void> {
    const pending = (this.state.instances as object[]).filter((i) => !this.#seen.has(i));
    for (const instance of pending) this.#seen.add(instance);
    const initialized: object[] = [];
    for (const instance of pending) {
      if (this.closed) return;
      await ApplicationContext.#call(instance, 'onModuleInit');
      this.#initialized.push(instance);
      initialized.push(instance);
      // Pushed after close() took its snapshot of #initialized: shut it down here.
      if (this.closed) return ApplicationContext.#shutDown([instance], this.#closeSignal);
    }
    for (const instance of initialized) {
      if (this.closed) return;
      await ApplicationContext.#call(instance, 'onApplicationBootstrap');
    }
  }

  /**
   * Keeps the error of the cleanup that followed a failed startup hook as `shutdownError` on the
   * startup error, which is rethrown as is.
   */
  static #attachShutdownError(error: unknown, shutdownError: unknown): void {
    if (typeof error !== 'object' || error === null || Object.hasOwn(error, 'shutdownError')) {
      return;
    }
    try {
      Object.defineProperty(error, 'shutdownError', {
        value: shutdownError,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } catch {
      // A frozen or non-extensible error is rethrown without it.
    }
  }

  get<T>(token: Token<T>): T {
    const visible = this.root.injector.lookup(token);
    if (visible) return this.root.injector.resolveRecords(visible) as T;
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
    if (this.#closing === undefined) {
      this.#closeSignal = signal;
      this.#closing = ApplicationContext.#shutDown([...this.#initialized].reverse(), signal);
    }
    return this.#closing;
  }

  /** The shutdown hooks of `instances`, in order; hook errors are collected and rethrown. */
  static async #shutDown(instances: readonly object[], signal: string | undefined): Promise<void> {
    const errors: unknown[] = [];
    for (const [name, arg] of [
      ['beforeApplicationShutdown', signal],
      ['onModuleDestroy', undefined],
    ] as const) {
      for (const instance of instances) {
        try {
          await ApplicationContext.#call(instance, name, arg);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Application shutdown failed');
  }

  static async #call(instance: object, name: string, arg?: unknown): Promise<void> {
    const fn = (instance as Record<string, unknown>)[name];
    if (typeof fn === 'function') await fn.call(instance, arg);
  }
}
