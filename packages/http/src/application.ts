import {
  ApplicationContext,
  Module,
  type ModuleImport,
  type Provider,
  type Token,
} from '@hpmws/core';
import type { Serve, Server, TLSOptions } from 'bun';
import { type CompiledApp, compileApplication, type RouteTableEntry } from './compiler.js';
import { HttpConfigError } from './exceptions.js';
import { ConsoleLogger, LOGGER, type Logger } from './logger.js';
import { compileTrust, type TrustProxy } from './net.js';
import { resolveFilter, resolveGuard, resolveMiddleware } from './resolve.js';
import { APP_FILTER, APP_GUARD, APP_MIDDLEWARE } from './tokens.js';
import type { FilterRef, GlobalMiddleware, GuardRef, MiddlewareRef } from './types.js';
import { type WsData, WsRegistry } from './ws.js';

/** Global module the factory registers: provides LOGGER and WsRegistry everywhere. */
@Module({})
export class HttpCoreModule {}

export interface CreateApplicationOptions {
  overrides?: Iterable<readonly [Token, Provider]>;
  logger?: Logger;
  /** Development mode exposes error details in 500 responses. Defaults to NODE_ENV === 'development'. */
  development?: boolean;
}

export interface ListenOptions {
  port?: number;
  hostname?: string;
  tls?: TLSOptions | TLSOptions[];
  /** Starts a second plain-HTTP listener that 308-redirects to the HTTPS listener. */
  redirectHttp?: { port: number; hostname?: string };
  trustProxy?: TrustProxy;
  maxRequestBodySize?: number;
  idleTimeout?: number;
  /** Max time close() waits for in-flight requests before forcing connections closed. Default 10s. */
  shutdownTimeout?: number;
}

export class HpmwsFactory {
  static async create(
    root: ModuleImport,
    options: CreateApplicationOptions = {},
  ): Promise<HttpApplication> {
    const core = {
      module: HttpCoreModule,
      global: true,
      providers: [{ provide: LOGGER, useValue: options.logger ?? new ConsoleLogger() }, WsRegistry],
      exports: [LOGGER, WsRegistry],
    };
    const context = await ApplicationContext.create(root, {
      overrides: options.overrides,
      globalModules: [core],
    });
    const development = options.development ?? process.env.NODE_ENV === 'development';
    return new HttpApplication(context, context.get(LOGGER), development);
  }
}

export class HttpApplication {
  #server: Server<WsData> | undefined;
  #compiled: CompiledApp | undefined;
  readonly #extraMiddleware: GlobalMiddleware[] = [];
  readonly #extraGuards: GuardRef<any>[] = [];
  readonly #extraFilters: FilterRef[] = [];
  protected serveOptions: Record<string, unknown> | undefined;
  protected shutdownTimeout = 10_000;

  constructor(
    readonly context: ApplicationContext,
    readonly logger: Logger,
    readonly development: boolean,
  ) {}

  get<T>(token: Token<T>): T {
    return this.context.get(token);
  }

  useGlobalMiddleware(middleware: MiddlewareRef, priority = 0): this {
    this.#assertNotListening('useGlobalMiddleware');
    this.#extraMiddleware.push({ middleware, priority });
    return this;
  }

  useGlobalGuards(...guards: GuardRef<any>[]): this {
    this.#assertNotListening('useGlobalGuards');
    this.#extraGuards.push(...guards);
    return this;
  }

  useGlobalFilters(...filters: FilterRef[]): this {
    this.#assertNotListening('useGlobalFilters');
    this.#extraFilters.push(...filters);
    return this;
  }

  get server(): Server<WsData> {
    if (!this.#server)
      throw new HttpConfigError('The application is not listening; call listen() first.');
    return this.#server;
  }

  get url(): URL {
    return this.server.url;
  }

  get routes(): readonly RouteTableEntry[] {
    return this.#compiled?.table ?? [];
  }

  async listen(options: ListenOptions = {}): Promise<Server<WsData>> {
    if (this.#server) throw new HttpConfigError('listen() was already called.');
    const root = this.context.root.injector;
    const entries = [
      ...this.context
        .collectEntries(APP_MIDDLEWARE)
        .map(({ value, injector }) => ({ entry: value, injector })),
      ...this.#extraMiddleware.map((entry) => ({ entry, injector: root })),
    ]
      .map((item, index) => ({ ...item, index }))
      .sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0) || a.index - b.index);
    const ws = this.context.get(WsRegistry);
    const compiled = compileApplication({
      modules: this.context.modules,
      globalMiddleware: entries.map(({ entry, injector }) =>
        resolveMiddleware(entry.middleware, injector),
      ),
      globalGuards: [
        ...this.context
          .collectEntries(APP_GUARD)
          .map(({ value, injector }) => resolveGuard(value, injector)),
        ...this.#extraGuards.map((g) => resolveGuard(g, root)),
      ],
      globalFilters: [
        ...this.context
          .collectEntries(APP_FILTER)
          .map(({ value, injector }) => resolveFilter(value, injector)),
        ...this.#extraFilters.map((f) => resolveFilter(f, root)),
      ],
      logger: this.logger,
      development: this.development,
      net: { trust: compileTrust(options.trustProxy ?? false), tls: options.tls !== undefined },
      ws,
    });

    const serveOptions: Record<string, unknown> = {
      port: options.port ?? 3000,
      hostname: options.hostname ?? '0.0.0.0',
      routes: compiled.routes,
      fetch: compiled.fetch,
      websocket: ws.handler(),
    };
    if (options.tls !== undefined) serveOptions.tls = options.tls;
    if (options.maxRequestBodySize !== undefined)
      serveOptions.maxRequestBodySize = options.maxRequestBodySize;
    if (options.idleTimeout !== undefined) serveOptions.idleTimeout = options.idleTimeout;
    const server = Bun.serve(serveOptions as unknown as Serve.Options<WsData, string>);
    ws.seal();
    this.#compiled = compiled;
    this.serveOptions = serveOptions;
    this.shutdownTimeout = options.shutdownTimeout ?? 10_000;
    this.#server = server;
    this.onListening(options);
    this.logger.info(`Listening on ${this.#server.url}`);
    return this.#server;
  }

  /** Hook for Task 15 (redirect listener). */
  protected onListening(_options: ListenOptions): void {}

  #assertNotListening(method: string): void {
    if (this.#server) throw new HttpConfigError(`${method}() must be called before listen().`);
  }
}
