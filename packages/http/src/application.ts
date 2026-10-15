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

/** 308 redirect to the same URL on the HTTPS listener. */
export function redirectToHttps(req: Request, httpsPort: number): Response {
  const url = new URL(req.url);
  url.protocol = 'https:';
  url.port = httpsPort === 443 ? '' : String(httpsPort);
  return new Response(null, { status: 308, headers: { location: url.toString() } });
}

export class HttpApplication {
  #server: Server<WsData> | undefined;
  #retired: Server<WsData>[] = [];
  #redirect: Server<undefined> | undefined;
  #closing: Promise<void> | undefined;
  readonly #signalHandlers: [NodeJS.Signals, () => void][] = [];
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

  get redirectUrl(): URL | undefined {
    return this.#redirect?.url;
  }

  /**
   * Bun's server.reload() keeps the original certificate, so a replacement listener is bound
   * to the same port (SO_REUSEPORT) and the old one drains its in-flight requests.
   */
  async reloadTls(tls: TLSOptions | TLSOptions[]): Promise<void> {
    if (!this.serveOptions?.tls) {
      throw new HttpConfigError('reloadTls() requires an application that listens with tls.');
    }
    if (process.platform !== 'linux') {
      throw new HttpConfigError('reloadTls() requires Linux (SO_REUSEPORT load balancing).');
    }
    const previous = this.server;
    const next = { ...this.serveOptions, tls, port: previous.port };
    this.#server = Bun.serve(next as unknown as Serve.Options<WsData, string>);
    this.serveOptions = next;
    this.#retired.push(previous);
    await previous.stop(false);
    this.#retired = this.#retired.filter((s) => s !== previous);
  }

  /** Graceful, idempotent shutdown. */
  close(signal?: string): Promise<void> {
    this.#closing ??= this.#shutdown(signal);
    return this.#closing;
  }

  enableShutdownHooks(
    signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'],
    options: { exit?: boolean } = {},
  ): this {
    for (const signal of signals) {
      const handler = () => {
        void this.close(signal).finally(() => {
          if (options.exit ?? true) process.exit(0);
        });
      };
      process.once(signal, handler);
      this.#signalHandlers.push([signal, handler]);
    }
    return this;
  }

  async #shutdown(signal?: string): Promise<void> {
    const servers = [...this.#retired, ...(this.#server ? [this.#server] : [])];
    if (servers.length > 0) {
      for (const server of servers) void server.stop(false);
      this.#redirect?.stop(true);
      const deadline = Date.now() + this.shutdownTimeout;
      const pending = () => servers.reduce((n, server) => n + server.pendingRequests, 0);
      while (pending() > 0 && Date.now() < deadline) await Bun.sleep(10);
      this.context.get(WsRegistry).closeAll(1001, 'Server shutting down');
      await Promise.all(servers.map((server) => server.stop(true)));
    }
    for (const [sig, handler] of this.#signalHandlers) process.off(sig, handler);
    this.#signalHandlers.length = 0;
    await this.context.close(signal);
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
    if (options.tls !== undefined) {
      serveOptions.tls = options.tls;
      // Required by reloadTls(): a replacement listener binds the same port.
      serveOptions.reusePort = true;
    }
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

  protected onListening(options: ListenOptions): void {
    if (!options.redirectHttp) return;
    const httpsPort = this.server.port;
    if (httpsPort === undefined) {
      throw new HttpConfigError('redirectHttp requires a TCP listener.');
    }
    this.#redirect = Bun.serve({
      port: options.redirectHttp.port,
      hostname: options.redirectHttp.hostname ?? options.hostname ?? '0.0.0.0',
      fetch: (req) => redirectToHttps(req, httpsPort),
    });
  }

  #assertNotListening(method: string): void {
    if (this.#server) throw new HttpConfigError(`${method}() must be called before listen().`);
  }
}
