import {
  AsyncProviderPendingError,
  CircularDependencyError,
  NoProviderError,
  ProviderConfigError,
} from './errors.js';
import {
  type InjectOptions,
  type InjectorLike,
  runInInjectionContext,
} from './injection-context.js';
import { type NormalizedProvider, normalizeProvider, type Provider } from './providers.js';
import { type Token, type Type, tokenName } from './tokens.js';

export interface ProviderRecord {
  readonly provider: NormalizedProvider;
  readonly owner: ModuleInjector;
  state: 'idle' | 'ready';
  value?: unknown;
  pending?: Promise<unknown> | undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

/** Resolution state shared by every module injector of one application. */
export class ContainerState {
  readonly stack: ProviderRecord[] = [];
  /** Constructed instances in completion order: dependencies always precede dependents. */
  readonly instances: unknown[] = [];
  readonly injectors: ModuleInjector[] = [];
  readonly overrides: ReadonlyMap<Token, NormalizedProvider>;
  globals: readonly ModuleInjector[] = [];
  /**
   * Open tracking scopes: bootstrap (until endBootstrap()) and trackAll() calls. Inside one every
   * transient is tracked; otherwise only one constructed for a singleton (#singletonsBuilding),
   * so transients resolved at runtime are neither kept nor given hooks.
   */
  #scopes = 1;
  /** Singletons on the stack: a transient built under one is created once per singleton. */
  #singletonsBuilding = 0;
  readonly #tracked = new Set<unknown>();
  /**
   * One list per record on the stack: the transients tracked for the instance it constructs
   * (directly, or through a transient it depends on). When that construction throws (as when
   * it hits an unsettled async factory and is retried), they are untracked: nothing holds them.
   */
  readonly #transientFrames: unknown[][] = [];

  constructor(overrides: Iterable<readonly [Token, Provider]> = []) {
    const map = new Map<Token, NormalizedProvider>();
    for (const [token, provider] of overrides) {
      map.set(token, { ...normalizeProvider(provider), token, multi: false });
    }
    this.overrides = map;
  }

  /** Synchronous resolution. Throws AsyncProviderPendingError for an unsettled async factory. */
  resolve(record: ProviderRecord): unknown {
    if (record.state === 'ready') return record.value;
    if (record.pending)
      throw new AsyncProviderPendingError(record, tokenName(record.provider.token));
    const p = record.provider;
    if (p.kind === 'value') {
      record.value = p.value;
      record.state = 'ready';
      return p.value;
    }
    const at = this.stack.indexOf(record);
    if (at !== -1) {
      const path = [...this.stack.slice(at), record].map((r) => tokenName(r.provider.token));
      throw new CircularDependencyError(path);
    }
    this.stack.push(record);
    const singleton = p.scope === 'singleton' && p.kind !== 'existing';
    if (singleton) this.#singletonsBuilding++;
    const frame: unknown[] = [];
    this.#transientFrames.push(frame);
    let value: unknown;
    try {
      value = record.owner.instantiate(record);
    } catch (error) {
      this.#untrack(frame);
      throw error;
    } finally {
      this.#transientFrames.pop();
      if (singleton) this.#singletonsBuilding--;
      this.stack.pop();
    }
    const tracked =
      p.kind !== 'existing' &&
      (p.scope !== 'transient' || this.#tracksTransient()) &&
      this.#track(value);
    if (p.scope === 'transient' || p.kind === 'existing') {
      // A transient (or an alias of one) and the transients it holds belong to the instance
      // being constructed, if any.
      const parent = this.#transientFrames.at(-1);
      if (parent !== undefined) {
        parent.push(...frame);
        if (p.scope === 'transient' && tracked) parent.push(value);
      }
      if (p.scope === 'transient') return value;
    }
    record.value = value;
    record.state = 'ready';
    return value;
  }

  /** Closes the bootstrap tracking scope (ApplicationContext.create, once started). */
  endBootstrap(): void {
    this.#scopes--;
  }

  /** Runs `fn` with every instance it constructs tracked, transients included. */
  trackAll<T>(fn: () => T): T {
    this.#scopes++;
    try {
      return fn();
    } finally {
      this.#scopes--;
    }
  }

  /**
   * Resolves a record that may be (or depend on) an async factory. When a synchronous
   * resolution hits an unsettled async factory, that factory is awaited first and the
   * dependent resolution is retried, so the part of a dependent factory before its first
   * await may run more than once. Factories must call inject() before their first await.
   */
  async resolveAsync(
    record: ProviderRecord,
    waiting: readonly ProviderRecord[] = [],
  ): Promise<void> {
    for (;;) {
      if (record.state === 'ready') return;
      try {
        if (record.pending) {
          // An `async` factory never throws synchronously: an AsyncProviderPendingError raised
          // by inject() before its first await arrives here as a rejection, handled below.
          let value: unknown;
          try {
            value = await record.pending;
          } finally {
            record.pending = undefined;
          }
          record.value = value;
          record.state = 'ready';
          this.#track(value);
          return;
        }
        this.resolve(record);
        return;
      } catch (error) {
        if (!(error instanceof AsyncProviderPendingError)) throw error;
        const dependency = error.record as ProviderRecord;
        if (dependency === record) continue;
        if (waiting.includes(dependency)) {
          throw new CircularDependencyError(
            [...waiting, record, dependency].map((r) => tokenName(r.provider.token)),
          );
        }
        await this.resolveAsync(dependency, [...waiting, record]);
      }
    }
  }

  /**
   * Whether a transient being constructed now is a startup instance: inside a tracking scope, or
   * as a dependency of a singleton under construction (created at most once per singleton).
   */
  #tracksTransient(): boolean {
    return this.#scopes > 0 || this.#singletonsBuilding > 0;
  }

  /** Untracks the transients of a construction that threw. */
  #untrack(transients: readonly unknown[]): void {
    for (const value of transients) {
      if (!this.#tracked.delete(value)) continue;
      const at = this.instances.lastIndexOf(value);
      if (at !== -1) this.instances.splice(at, 1);
    }
  }

  /** Tracks `value`; true when it was not tracked before. */
  #track(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || this.#tracked.has(value)) return false;
    this.#tracked.add(value);
    this.instances.push(value);
    return true;
  }
}

export class ModuleInjector implements InjectorLike {
  readonly records = new Map<Token, ProviderRecord[]>();
  readonly imports: ModuleInjector[] = [];
  /** token → the injector whose own records hold it (itself, or a re-exported module). */
  readonly exported = new Map<Token, ModuleInjector>();
  readonly #constructed = new Map<Type, ProviderRecord>();

  constructor(
    readonly name: string,
    readonly state: ContainerState,
  ) {
    state.injectors.push(this);
  }

  addProvider(provider: NormalizedProvider): void {
    const override = provider.multi ? undefined : this.state.overrides.get(provider.token);
    const record: ProviderRecord = { provider: override ?? provider, owner: this, state: 'idle' };
    const list = this.records.get(provider.token);
    if (!list) {
      this.records.set(provider.token, [record]);
      return;
    }
    if (list[0]!.provider.multi !== provider.multi) {
      throw new ProviderConfigError(
        `${tokenName(provider.token)} is registered in ${this.name} both with and without multi: true.`,
      );
    }
    if (provider.multi) list.push(record);
    else list[0] = record;
  }

  *ownRecords(): IterableIterator<ProviderRecord> {
    for (const list of this.records.values()) yield* list;
  }

  get<T>(token: Token<T>, options?: InjectOptions): T | undefined {
    const records = this.lookup(token);
    if (!records) {
      if (options?.optional) return undefined;
      throw this.noProvider(token);
    }
    return this.resolveRecords(records) as T;
  }

  /** @internal Resolves lookup() records: all of a multi token, else the single one. */
  resolveRecords(records: readonly ProviderRecord[]): unknown {
    if (records[0]!.provider.multi) return records.map((r) => this.state.resolve(r));
    return this.state.resolve(records[0]!);
  }

  /** Own providers first, then exports of imported modules, then exports of global modules. */
  lookup(token: Token): ProviderRecord[] | undefined {
    const own = this.records.get(token);
    if (own && !own[0]!.provider.multi) return own;
    const collected: ProviderRecord[] = own ? [...own] : [];
    for (const source of this.#sources()) {
      const records = source.exported.get(token)?.records.get(token);
      if (!records) continue;
      if (!records[0]!.provider.multi) {
        if (collected.length === 0) return records;
        continue;
      }
      for (const r of records) if (!collected.includes(r)) collected.push(r);
    }
    return collected.length > 0 ? collected : undefined;
  }

  instantiate(record: ProviderRecord): unknown {
    const p = record.provider;
    switch (p.kind) {
      case 'value':
        return p.value;
      case 'class':
        return runInInjectionContext(this, () => new p.useClass());
      case 'existing':
        return this.get(p.existing);
      case 'factory': {
        const result = runInInjectionContext(this, p.factory);
        if (!isPromiseLike(result)) return result;
        if (p.scope === 'transient') {
          throw new ProviderConfigError(
            `Transient provider ${tokenName(p.token)} cannot use an async factory.`,
          );
        }
        record.pending = Promise.resolve(result);
        record.pending.catch(() => {});
        throw new AsyncProviderPendingError(record, tokenName(p.token));
      }
    }
  }

  noProvider(token: Token): NoProviderError {
    const top = this.state.stack.at(-1);
    const requester = top ? tokenName(top.provider.token) : 'ApplicationContext';
    const name = tokenName(token);
    return new NoProviderError(
      `${requester} (${this.name}) requested ${name}, but no provider is visible. ${this.#hint(token, name)}`,
    );
  }

  #hint(token: Token, name: string): string {
    const owner = this.state.injectors.find((i) => i !== this && i.records.has(token));
    if (!owner) {
      return `No module provides ${name}. Add it to the providers of ${this.name} or of a module that ${this.name} imports.`;
    }
    if (!owner.exported.has(token)) return `${name} is provided by ${owner.name} but not exported.`;
    return `${name} is exported by ${owner.name}; add ${owner.name} to the imports of ${this.name}.`;
  }

  *#sources(): IterableIterator<ModuleInjector> {
    yield* this.imports;
    for (const g of this.state.globals) if (g !== this && !this.imports.includes(g)) yield g;
  }

  /**
   * Resolves `cls` if it is visible as a provider; otherwise constructs it once per module in
   * this module's injection context (honouring overrides). Used for guards, middleware, filters.
   */
  resolveOrConstruct<T>(cls: Type<T>): T {
    let record = this.#constructed.get(cls);
    if (!record) {
      const visible = this.lookup(cls);
      if (visible) return this.resolveRecords(visible) as T;
      const provider = this.state.overrides.get(cls) ?? {
        kind: 'class' as const,
        token: cls,
        useClass: cls,
        scope: 'singleton' as const,
        multi: false,
      };
      record = { provider, owner: this, state: 'idle' };
      this.#constructed.set(cls, record);
    }
    try {
      return this.state.resolve(record) as T;
    } catch (error) {
      // Async factories are settled by ApplicationContext.create(); one first reached here (an
      // override of a class constructed at listen()) can never be awaited.
      if (!(error instanceof AsyncProviderPendingError)) throw error;
      const pending = (error.record as ProviderRecord).provider.token;
      throw new ProviderConfigError(
        `The override of ${tokenName(pending)} cannot use an async factory.`,
      );
    }
  }
}
