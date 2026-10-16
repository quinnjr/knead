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
import { compileTrust, parseIp, type TrustProxy } from './net.js';
import { requestUrl } from './request.js';
import { resolveFilter, resolveGuard, resolveMiddleware } from './resolve.js';
import { APP_FILTER, APP_GUARD, APP_MIDDLEWARE, HTTP_DEVELOPMENT } from './tokens.js';
import type { FilterRef, GlobalMiddleware, GuardRef, MiddlewareRef } from './types.js';
import { type WsData, WsRegistry, type WsServerOptions } from './ws.js';

/** Default `maxRequestBodySize`: 1 MiB. */
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 1024 * 1024;

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
  /**
   * Starts a second plain-HTTP listener that 308-redirects to the HTTPS listener. `host` is the
   * canonical host (`example.com`, or `example.com:8443` to override the port) used in the
   * Location header; when set, the request's Host header is ignored.
   */
  redirectHttp?: { port: number; hostname?: string; host?: string };
  trustProxy?: TrustProxy;
  /**
   * WebSocket limits: 256 KiB messages, 1 MiB backpressure (closing), 120s idle timeout,
   * 100 sockets per IP and 100 messages per 10s per socket by default.
   */
  websocket?: WsServerOptions;
  /** Largest accepted request body in bytes; larger bodies get 413. Default 1 MiB. */
  maxRequestBodySize?: number;
  idleTimeout?: number;
  /**
   * Max time close() waits for in-flight requests before forcing connections closed, and for a
   * listen() that is still initializing. Default 10s. If that wait times out, the listen is
   * abandoned (it rejects without binding) and classes whose onModuleInit was still running do
   * not receive onModuleDestroy.
   */
  shutdownTimeout?: number;
}

export class HpmwsFactory {
  static async create(
    root: ModuleImport,
    options: CreateApplicationOptions = {},
  ): Promise<HttpApplication> {
    const development = options.development ?? process.env.NODE_ENV === 'development';
    const core = {
      module: HttpCoreModule,
      global: true,
      providers: [
        { provide: LOGGER, useValue: options.logger ?? new ConsoleLogger() },
        { provide: HTTP_DEVELOPMENT, useValue: development },
        WsRegistry,
      ],
      exports: [LOGGER, HTTP_DEVELOPMENT, WsRegistry],
    };
    const context = await ApplicationContext.create(root, {
      overrides: options.overrides,
      globalModules: [core],
    });
    return new HttpApplication(context, context.get(LOGGER), development);
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const bytes = parseIp(host);
  if (bytes?.length === 4) return bytes[0] === 127;
  return bytes?.every((b, i) => b === (i === 15 ? 1 : 0)) === true;
}

/** A host name or IP literal with an optional port, and nothing else. */
const CANONICAL_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * 308 redirect to the same URL on the HTTPS listener. With `host` (a canonical `host[:port]`),
 * the request's Host is ignored; a port in `host` overrides `httpsPort`.
 */
export function redirectToHttps(req: Request, httpsPort: number, host?: string): Response {
  if (host === undefined && !URL.canParse(req.url)) {
    // The Host header did not form a URL, and there is no canonical host to send the client to.
    return new Response('Invalid Host header', {
      status: 400,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  const url = requestUrl(req);
  url.protocol = 'https:';
  let port = String(httpsPort);
  if (host !== undefined) {
    const [, name, explicitPort] = /^(.+?)(?::(\d+))?$/.exec(host) ?? [];
    url.hostname = name ?? host;
    if (explicitPort !== undefined) port = explicitPort;
  }
  url.port = port === '443' ? '' : port;
  return new Response(null, {
    status: 308,
    headers: {
      location: url.toString(),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export class HttpApplication {
  #server: Server<WsData> | undefined;
  #retired: Server<WsData>[] = [];
  #redirect: Server<undefined> | undefined;
  #closing: Promise<void> | undefined;
  /** The in-flight listen(), so close() can wait for it to settle. */
  #pendingListen: Promise<unknown> | undefined;
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

  /** The TCP port of the main listener. */
  get port(): number {
    const port = this.server.port;
    if (port === undefined) throw new HttpConfigError('The application has no TCP port.');
    return port;
  }

  get redirectUrl(): URL | undefined {
    return this.#redirect?.url;
  }

  /**
   * Bun's server.reload() keeps the original certificate, so a replacement listener is bound
   * to the same port (SO_REUSEPORT) and the old one drains its in-flight requests.
   */
  async reloadTls(tls: TLSOptions | TLSOptions[]): Promise<void> {
    if (this.#closing) {
      throw new HttpConfigError('reloadTls() cannot be called while the application is closing.');
    }
    if (!this.serveOptions?.tls) {
      throw new HttpConfigError('reloadTls() requires an application that listens with tls.');
    }
    if (process.platform !== 'linux') {
      throw new HttpConfigError('reloadTls() requires Linux (SO_REUSEPORT load balancing).');
    }
    const previous = this.server;
    const next = { ...this.serveOptions, tls, port: this.port };
    this.#server = Bun.serve(next as unknown as Serve.Options<WsData, string>);
    this.serveOptions = next;
    this.#retired.push(previous);
    // stop(false) stays pending while WebSockets remain open on the old listener, so it is
    // not awaited: wait only for in-flight requests (bounded); close() reaps the rest.
    void previous.stop(false).then(
      () => {
        this.#retired = this.#retired.filter((s) => s !== previous);
      },
      () => {},
    );
    const deadline = Date.now() + this.shutdownTimeout;
    while (previous.pendingRequests > 0 && Date.now() < deadline) await Bun.sleep(10);
  }

  /**
   * Graceful, idempotent shutdown. If listen() is still initializing (running onModuleInit of
   * middleware, guards or filters), close() waits up to shutdownTimeout for it; past that the
   * listen is abandoned and rejects without binding, and classes whose onModuleInit was still
   * running do not receive onModuleDestroy.
   */
  close(signal?: string): Promise<void> {
    this.#closing ??= this.#shutdown(signal);
    return this.#closing;
  }

  enableShutdownHooks(
    signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'],
    options: { exit?: boolean } = {},
  ): this {
    if (this.#closing) {
      throw new HttpConfigError('enableShutdownHooks() cannot be called after close().');
    }
    const exit = options.exit ?? true;
    for (const signal of signals) {
      const handler = () => {
        this.close(signal).then(
          () => {
            if (exit) process.exit(0);
          },
          (error) => {
            this.logger.error(`Graceful shutdown on ${signal} failed`, error);
            if (exit) process.exit(1);
          },
        );
      };
      process.once(signal, handler);
      this.#signalHandlers.push([signal, handler]);
    }
    return this;
  }

  async #shutdown(signal?: string): Promise<void> {
    // A listen() still initializing sees #closing after its await and rejects without binding;
    // waiting for it keeps its late-initialized instances inside the shutdown below. The wait is
    // bounded by shutdownTimeout so a stalled hook (or one that awaits close()) cannot deadlock
    // shutdown; an abandoned listen still rejects without binding.
    if (this.#pendingListen) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.#pendingListen.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.shutdownTimeout);
        }),
      ]);
      clearTimeout(timer);
    }
    let failure: { error: unknown } | undefined;
    try {
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
    } catch (error) {
      failure = { error };
    } finally {
      for (const [sig, handler] of this.#signalHandlers) process.off(sig, handler);
      this.#signalHandlers.length = 0;
    }
    await this.context.close(signal);
    if (failure) throw failure.error;
  }

  /**
   * Compiles the routes and binds the listener(s). A listen() that failed to bind (e.g. the port
   * is in use) leaves no partial state and may be retried, but the bootstrapped context stays
   * open: callers that give up must `await app.close()` to run shutdown hooks and release
   * resources such as database connections. If a lifecycle hook of a lazily constructed class
   * fails, the application is closed and cannot be retried. listen() rejects once close() has
   * started, including a close() that arrives while listen() is still initializing.
   */
  async listen(options: ListenOptions = {}): Promise<Server<WsData>> {
    if (this.#closing || this.context.closed) {
      throw new HttpConfigError('The application is closed.');
    }
    if (this.#server || this.#pendingListen) {
      throw new HttpConfigError('listen() was already called.');
    }
    const pending = this.#listen(options);
    this.#pendingListen = pending;
    try {
      return await pending;
    } finally {
      this.#pendingListen = undefined;
    }
  }

  async #listen(options: ListenOptions): Promise<Server<WsData>> {
    // Set first: a close() during the late-init await bounds its wait with this timeout.
    this.shutdownTimeout = options.shutdownTimeout ?? 10_000;
    if (options.redirectHttp && options.tls === undefined) {
      throw new HttpConfigError('redirectHttp requires tls.');
    }
    const canonicalHost = options.redirectHttp?.host;
    if (canonicalHost !== undefined && !CANONICAL_HOST.test(canonicalHost)) {
      throw new HttpConfigError(
        `redirectHttp.host must be a plain host[:port], got ${JSON.stringify(canonicalHost)}.`,
      );
    }
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
    ws.configure(options.websocket ?? {});
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
    // Middleware, guards and filters constructed by the compiler get their init hooks now (and
    // shutdown hooks at close()); a failing hook rejects listen() before anything is bound.
    await this.context.initializeLate();
    if (this.#closing || this.context.closed) {
      throw new HttpConfigError('The application was closed during listen().');
    }

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
    serveOptions.maxRequestBodySize = options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE;
    if (options.idleTimeout !== undefined) serveOptions.idleTimeout = options.idleTimeout;
    const server = Bun.serve(serveOptions as unknown as Serve.Options<WsData, string>);
    let redirect: Server<undefined> | undefined;
    try {
      redirect = this.#startRedirect(options, server);
    } catch (error) {
      try {
        await server.stop(true);
      } catch (stopError) {
        this.logger.error('Failed to release the HTTPS listener after a bind failure', stopError);
      }
      throw error;
    }
    ws.seal();
    this.#compiled = compiled;
    this.serveOptions = serveOptions;
    this.#redirect = redirect;
    this.#server = server;
    this.logger.info(`Listening on ${server.url}`);
    if (this.development && !isLoopback(serveOptions.hostname as string)) {
      this.logger.warn(
        `Running in development mode on ${serveOptions.hostname}, which is reachable from other ` +
          'hosts: development exposes error details. Bind to 127.0.0.1, or set development: false.',
      );
    }
    return server;
  }

  #startRedirect(options: ListenOptions, server: Server<WsData>): Server<undefined> | undefined {
    if (!options.redirectHttp) return undefined;
    const httpsPort = server.port;
    if (httpsPort === undefined) {
      throw new HttpConfigError('redirectHttp requires a TCP listener.');
    }
    return Bun.serve({
      port: options.redirectHttp.port,
      hostname: options.redirectHttp.hostname ?? options.hostname ?? '0.0.0.0',
      fetch: (req) => redirectToHttps(req, httpsPort, options.redirectHttp?.host),
    });
  }

  #assertNotListening(method: string): void {
    if (this.#server) throw new HttpConfigError(`${method}() must be called before listen().`);
  }
}
