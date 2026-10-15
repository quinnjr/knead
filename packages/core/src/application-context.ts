import type { ModuleImport } from './decorators.js';
import { ContainerState } from './injector.js';
import { buildModuleGraph, type ModuleRef } from './modules.js';
import type { Provider } from './providers.js';
import type { Token } from './tokens.js';

export interface CreateContextOptions {
  /** Replace providers by token (used by @hpmws/testing). Applies to non-multi providers. */
  overrides?: Iterable<readonly [Token, Provider]>;
  /** Extra modules scanned before the root (e.g. framework core modules). */
  globalModules?: readonly ModuleImport[];
}

export class ApplicationContext {
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
    await context.#hook('onModuleInit');
    await context.#hook('onApplicationBootstrap');
    return context;
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
    const out: T[] = [];
    for (const m of this.modules) {
      for (const record of m.injector.records.get(token) ?? [])
        out.push(this.state.resolve(record) as T);
    }
    return out;
  }

  #closing: Promise<void> | undefined;

  /** Runs shutdown hooks once, in reverse construction order. */
  close(signal?: string): Promise<void> {
    this.#closing ??= (async () => {
      await this.#hook('beforeApplicationShutdown', true, signal);
      await this.#hook('onModuleDestroy', true);
    })();
    return this.#closing;
  }

  async #hook(name: string, reverse = false, arg?: unknown): Promise<void> {
    const list = reverse ? [...this.state.instances].reverse() : [...this.state.instances];
    for (const instance of list) {
      const fn = (instance as Record<string, unknown>)[name];
      if (typeof fn === 'function') await fn.call(instance, arg);
    }
  }
}
