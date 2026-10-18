import {
  ApplicationContext,
  Module,
  type ModuleImport,
  type Provider,
  type Token,
} from '@knead-js/core';
import type { Serve, Server, TLSOptions } from 'bun';
import {
  type CompiledApp,
  compileApplication,
  misdirectedResponse,
  type RouteTableEntry,
  withCacheControl,
} from './compiler.js';
import { ErrorLog, logError } from './error-log.js';
import { HttpConfigError } from './exceptions.js';
import { LOGGER, type Logger } from './logger.js';
import {
  compileAllowedHosts,
  compileTrust,
  type HostMatcher,
  isLoopbackHostname,
  type TrustProxy,
} from './net.js';
import { internalErrorResponse } from './pipeline.js';
import { DEFAULT_MAX_PARAMS, requestUrl } from './request.js';
import { resolveFilter, resolveGuard, resolveMiddleware } from './resolve.js';
import { isHeaderValue } from './response.js';
import { checkBunVersion } from './runtime-version.js';
import { APP_FILTER, APP_GUARD, APP_MIDDLEWARE } from './tokens.js';
import type { FilterRef, GlobalMiddleware, GuardRef, MiddlewareRef } from './types.js';
import type { ValidationOptions } from './validation.js';
import { type WsData, WsRegistry, type WsServerOptions } from './ws.js';

/** The longest delay setTimeout() honours: 2^31 - 1 ms. */
const MAX_TIMEOUT = 2 ** 31 - 1;

/** Default `maxRequestBodySize`: 1 MiB. */
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 1024 * 1024;

/**
 * Global module the factory registers: provides WsRegistry and ErrorLog everywhere.
 * HTTP_DEVELOPMENT (core's DEVELOPMENT) is provided by the ApplicationContext, from the
 * `development` option. LOGGER comes from @knead-js/core's default (a ConsoleLogger), unless a
 * global module such as LoggingModule provides one, or the `logger` option replaces it.
 */
@Module({})
export class HttpCoreModule {}

export interface CreateApplicationOptions {
  overrides?: Iterable<readonly [Token, Provider]>;
  /**
   * The LOGGER of every module, replacing any module's LOGGER provider (a LOGGER entry in
   * `overrides` still wins). Default: the LOGGER of a global module such as LoggingModule, or a
   * ConsoleLogger.
   */
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
   * Host names this server answers to (DNS rebinding protection): a request whose Host header
   * names another host gets 421 Misdirected Request, before middleware, routes and WebSocket
   * upgrades. Hostnames only, case-insensitive; ports are ignored. `false` disables the check.
   * Default in development: `localhost`, `127.0.0.1`, `[::1]` and the bound hostname (unless it
   * is `0.0.0.0` or `::`). Default in production: no check, since the public names are not
   * known; set it to them.
   */
  allowedHosts?: readonly string[] | false;
  /**
   * WebSocket limits: 256 KiB messages, 1 MiB backpressure (closing), 120s idle timeout,
   * 100 sockets per IP and 100 messages per 10s per socket by default.
   */
  websocket?: WsServerOptions;
  /**
   * Most query parameters (more is a 400) or urlencoded/multipart body fields (more is a 413)
   * parsed per request. Default 1000.
   */
  maxParams?: number;
  /**
   * Cache-Control for responses that set none (for example `'no-store'` for an API serving
   * per-user data). Default: none is added, so responses without one may be cached by browsers
   * and shared caches according to their heuristics.
   */
  defaultCacheControl?: string;
  /**
   * Request validation: `redactIssueMessages` makes params, query and body issue messages
   * generic.
   */
  validation?: ValidationOptions;
  /** Largest accepted request body in bytes; larger bodies get 413. Default 1 MiB. */
  maxRequestBodySize?: number;
  /**
   * Seconds a connection may stay idle before Bun closes it; passed to Bun.serve only when set,
   * so Bun's default (10s) applies otherwise. WebSocket idle time is `websocket.idleTimeout`.
   */
  idleTimeout?: number;
  /**
   * Max time close() waits for in-flight requests before forcing connections closed, and for a
   * listen() that is still initializing. Default 10s. If that wait times out, the listen is
   * abandoned (it rejects without binding); a class whose onModuleInit was still running receives
   * its shutdown hooks once that onModuleInit finishes, if it ever does.
   */
  shutdownTimeout?: number;
}

export class KneadFactory {
  static async create(
    root: ModuleImport,
    options: CreateApplicationOptions = {},
  ): Promise<HttpApplication> {
    const development = options.development ?? process.env.NODE_ENV === 'development';
    const core = {
      module: HttpCoreModule,
      global: true,
      providers: [WsRegistry, ErrorLog],
      exports: [WsRegistry, ErrorLog],
    };
    // Overrides apply to every LOGGER provider, so the logger option is the LOGGER everywhere.
    const overrides: (readonly [Token, Provider])[] = options.logger
      ? [[LOGGER, { provide: LOGGER, useValue: options.logger }]]
      : [];
    const context = await ApplicationContext.create(root, {
      overrides: [...overrides, ...(options.overrides ?? [])],
      globalModules: [core],
      development,
    });
    return new HttpApplication(context, context.get(LOGGER), development);
  }
}

/**
 * Throws HttpConfigError unless `value` is undefined or a safe integer from `min` to `max`
 * (a string from an environment variable, NaN or Infinity is rejected, not coerced).
 */
function assertIntegerOption(name: string, value: unknown, min: number, max?: number): void {
  if (value === undefined) return;
  if (
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (max === undefined || (value as number) <= max)
  ) {
    return;
  }
  const range = max === undefined ? `>= ${min}` : `from ${min} to ${max}`;
  const got = typeof value === 'string' ? JSON.stringify(value) : String(value);
  throw new HttpConfigError(`${name} must be an integer ${range}, got ${got}.`);
}

/** Loopback, including `*.localhost`. */
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return host.endsWith('.localhost') || isLoopbackHostname(host);
}

/** Whether a listen hostname binds every interface. */
function isWildcard(hostname: string): boolean {
  return hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]';
}

/** A host name or IP literal with an optional port, and nothing else. */
const CANONICAL_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** A `host[:port]` that the URL parser keeps exactly as written. */
interface CanonicalHost {
  /** Lowercased host name, or bracketed IPv6 literal. */
  readonly hostname: string;
  /** The explicit port (1-65535), if any. */
  readonly port: string | undefined;
}

/**
 * Parses a plain `host[:port]`. The URL parser silently rejects or rewrites many values a
 * pattern accepts (`1.2.3.256`, `[1.2.3.4]`, `xn--a`, `0x7f.1`, `[::0001]`, `:99999`), so the
 * host must round-trip: the parsed hostname and port equal the ones written (after lowercasing),
 * and an explicit port is 1-65535 without leading zeros. Anything else is undefined.
 */
function parseCanonicalHost(host: string): CanonicalHost | undefined {
  if (!CANONICAL_HOST.test(host)) return undefined;
  const [, name = '', port] = /^(\[[^\]]*\]|[^:]+)(?::(\d+))?$/.exec(host) ?? [];
  let url: URL;
  try {
    url = new URL(`https://${host}`);
  } catch {
    return undefined;
  }
  const hostname = name.toLowerCase();
  if (url.hostname !== hostname) return undefined;
  if (port !== undefined) {
    const n = Number(port);
    if (String(n) !== port || n < 1 || n > 65535 || (url.port || '443') !== port) return undefined;
  }
  return { hostname, port };
}

/** `https://host[:port]`, omitting the default port 443. */
function httpsOrigin(hostname: string, port: string): string {
  return `https://${hostname}${port === '443' ? '' : `:${port}`}`;
}

const REDIRECT_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

/** 308 to `origin` + the request's path and query; the request URL itself is never modified. */
function redirectTo(req: Request, origin: string): Response {
  const url = requestUrl(req);
  return new Response(null, {
    status: 308,
    headers: { location: `${origin}${url.pathname}${url.search}`, ...REDIRECT_HEADERS },
  });
}

function badHost(): Response {
  return new Response('Invalid Host header', {
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...REDIRECT_HEADERS },
  });
}

/**
 * The redirect origin for a canonical `redirectHttp.host`: a port in `host` overrides
 * `httpsPort`. Throws HttpConfigError unless `host` is a plain, round-tripping `host[:port]`.
 */
function canonicalOrigin(host: string, httpsPort: number): string {
  const parsed = parseCanonicalHost(host);
  if (!parsed) {
    throw new HttpConfigError(
      `redirectHttp.host must be a plain host[:port], got ${JSON.stringify(host)}.`,
    );
  }
  return httpsOrigin(parsed.hostname, parsed.port ?? String(httpsPort));
}

/**
 * 308 redirect to the same URL on the HTTPS listener. With `host` (a canonical `host[:port]`),
 * the request's Host is ignored; a port in `host` overrides `httpsPort`. Without it, a request
 * whose Host is not a plain, round-tripping `host[:port]` gets 400.
 * @throws HttpConfigError for a `host` that is not a plain, round-tripping `host[:port]`.
 */
export function redirectToHttps(req: Request, httpsPort: number, host?: string): Response {
  if (host !== undefined) return redirectTo(req, canonicalOrigin(host, httpsPort));
  // Without a canonical host the request's Host is used, so it must pass the same strict
  // host[:port] check as redirectHttp.host; its port is replaced by the HTTPS port.
  const requested =
    req.headers.get('host') ?? (URL.canParse(req.url) ? new URL(req.url).host : undefined);
  const parsed = requested === undefined ? undefined : parseCanonicalHost(requested);
  if (!parsed) return badHost();
  return redirectTo(req, httpsOrigin(parsed.hostname, String(httpsPort)));
}

export class HttpApplication {
  #server: Server<WsData> | undefined;
  #retired: Server<WsData>[] = [];
  #redirect: Server<undefined> | undefined;
  #closing: Promise<void> | undefined;
  /** The in-flight listen(), set from its start until it settles, so close() can wait for it. */
  #pendingListen: Promise<unknown> | undefined;
  readonly #signalHandlers: [NodeJS.Signals, () => void][] = [];
  #compiled: CompiledApp | undefined;
  /** `listen({ defaultCacheControl })`, for the answers made outside the compiled routes. */
  #defaultCacheControl: string | undefined;
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
   * listen is abandoned and rejects without binding. A class whose onModuleInit was still running
   * receives its shutdown hooks once that onModuleInit finishes, if it ever does.
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
            logError(this, `Graceful shutdown on ${signal} failed`, error);
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
        for (const server of servers) {
          server.stop(false).catch((error: unknown) => {
            logError(this, 'Stopping a listener failed', error);
          });
        }
        const redirectStopped = this.#redirect?.stop(true).catch((error: unknown) => {
          logError(this, 'Stopping the redirect listener failed', error);
        });
        const deadline = Date.now() + this.shutdownTimeout;
        const pending = () => servers.reduce((n, server) => n + server.pendingRequests, 0);
        while (pending() > 0 && Date.now() < deadline) await Bun.sleep(10);
        this.context.get(WsRegistry).closeAll(1001, 'Server shutting down');
        await Promise.all([...servers.map((server) => server.stop(true)), redirectStopped]);
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
    // Set before #listen() runs: hooks it calls synchronously already see a listen in progress.
    const { promise, resolve, reject } = Promise.withResolvers<Server<WsData>>();
    this.#pendingListen = promise;
    try {
      this.#listen(options).then(resolve, reject);
      return await promise;
    } finally {
      this.#pendingListen = undefined;
    }
  }

  async #listen(options: ListenOptions): Promise<Server<WsData>> {
    const { maxRequestBodySize, idleTimeout, shutdownTimeout } = options;
    // setTimeout() fires after ~1 ms for a delay of 2^31 ms or more.
    assertIntegerOption('shutdownTimeout', shutdownTimeout, 0, MAX_TIMEOUT);
    // Set first: a close() during the late-init await bounds its wait with this timeout.
    this.shutdownTimeout = shutdownTimeout ?? 10_000;
    assertIntegerOption('port', options.port, 0, 65535);
    assertIntegerOption('redirectHttp.port', options.redirectHttp?.port, 0, 65535);
    assertIntegerOption('maxRequestBodySize', maxRequestBodySize, 1);
    assertIntegerOption('idleTimeout', idleTimeout, 0, 255);
    if (options.redirectHttp && options.tls === undefined) {
      throw new HttpConfigError('redirectHttp requires tls.');
    }
    const hosts = this.#allowedHosts(options);
    const cc = options.defaultCacheControl;
    if (cc !== undefined && (typeof cc !== 'string' || cc === '' || !isHeaderValue(cc))) {
      throw new HttpConfigError(
        `defaultCacheControl must be a header value, got ${JSON.stringify(cc)}.`,
      );
    }
    // Before anything binds: Bun's error handler (#serverError) reads it.
    this.#defaultCacheControl = cc;
    assertIntegerOption('maxParams', options.maxParams, 1);
    const canonicalHost = options.redirectHttp?.host;
    // Validated before anything binds; the origin is computed once the HTTPS port is known.
    if (canonicalHost !== undefined) canonicalOrigin(canonicalHost, 443);
    const root = this.context.root.injector;
    const entries = [
      ...this.context
        .collectEntries(APP_MIDDLEWARE)
        .map(({ value, injector }) => ({ entry: value, injector, where: 'APP_MIDDLEWARE' })),
      ...this.#extraMiddleware.map((entry) => ({
        entry,
        injector: root,
        where: 'useGlobalMiddleware()',
      })),
    ]
      .map((item, index) => ({ ...item, index }))
      .sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0) || a.index - b.index);
    const ws = this.context.get(WsRegistry);
    ws.configure(options.websocket ?? {});
    // Transients built for the routes here (guards, middleware, filters) are startup instances:
    // tracked, so initializeLate() below gives them init hooks and close() shutdown hooks.
    const compiled = this.context.trackConstructed(() =>
      compileApplication({
        modules: this.context.modules,
        globalMiddleware: entries.map(({ entry, injector, where }) =>
          resolveMiddleware(entry.middleware, injector, where),
        ),
        globalGuards: [
          ...this.context
            .collectEntries(APP_GUARD)
            .map(({ value, injector }) => resolveGuard(value, injector, 'APP_GUARD')),
          ...this.#extraGuards.map((g) => resolveGuard(g, root, 'useGlobalGuards()')),
        ],
        globalFilters: [
          ...this.context
            .collectEntries(APP_FILTER)
            .map(({ value, injector }) => resolveFilter(value, injector, 'APP_FILTER')),
          ...this.#extraFilters.map((f) => resolveFilter(f, root, 'useGlobalFilters()')),
        ],
        logger: this.logger,
        development: this.development,
        net: {
          trust: compileTrust(options.trustProxy ?? false),
          tls: options.tls !== undefined,
          maxParams: options.maxParams ?? DEFAULT_MAX_PARAMS,
        },
        ws,
        hosts,
        validation: options.validation,
        defaultCacheControl: options.defaultCacheControl,
      }),
    );
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
      // Bun's own development mode follows NODE_ENV !== 'production' and renders an HTML page
      // with the error's message, stack and source; Knead's flag decides, and errors that reach
      // Bun get a masked problem.
      development: this.development,
      error: this.#serverError,
    };
    if (options.tls !== undefined) {
      serveOptions.tls = options.tls;
      // Required by reloadTls(): a replacement listener binds the same port.
      serveOptions.reusePort = true;
    }
    serveOptions.maxRequestBodySize = maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE;
    if (idleTimeout !== undefined) serveOptions.idleTimeout = idleTimeout;
    const server = Bun.serve(serveOptions as unknown as Serve.Options<WsData, string>);
    let redirect: Server<undefined> | undefined;
    try {
      redirect = this.#startRedirect(options, server, hosts);
    } catch (error) {
      try {
        await server.stop(true);
      } catch (stopError) {
        logError(this, 'Failed to release the HTTPS listener after a bind failure', stopError);
      }
      throw error;
    }
    ws.seal();
    this.#compiled = compiled;
    this.serveOptions = serveOptions;
    this.#redirect = redirect;
    this.#server = server;
    this.logger.info(`Listening on ${server.url}`);
    checkBunVersion(this.logger);
    const hostname = serveOptions.hostname as string;
    if (typeof options.trustProxy === 'number' && options.trustProxy > 0 && isWildcard(hostname)) {
      this.logger.warn(
        `trustProxy is a hop count (${options.trustProxy}) and the server listens on ${hostname}: ` +
          'a client that reaches the port directly, bypassing the proxy, can choose its own ' +
          'ctx.ip. Use the proxy CIDRs as trustProxy, or firewall the port to the proxy.',
      );
    }
    if (this.development && !isLoopback(serveOptions.hostname as string)) {
      this.logger.warn(
        `Running in development mode on ${serveOptions.hostname}, which is reachable from other ` +
          'hosts: development exposes error details. Bind to 127.0.0.1, or set development: false.',
      );
    }
    return server;
  }

  #allowedHosts(options: ListenOptions): HostMatcher | undefined {
    if (options.allowedHosts === false) return undefined;
    if (options.allowedHosts !== undefined) return compileAllowedHosts(options.allowedHosts);
    if (!this.development) return undefined;
    const bound = options.hostname ?? '0.0.0.0';
    const defaults = ['localhost', '127.0.0.1', '[::1]'];
    if (!isWildcard(bound)) defaults.push(bound);
    return compileAllowedHosts(defaults);
  }

  #startRedirect(
    options: ListenOptions,
    server: Server<WsData>,
    hosts: HostMatcher | undefined,
  ): Server<undefined> | undefined {
    if (!options.redirectHttp) return undefined;
    const httpsPort = server.port;
    if (httpsPort === undefined) {
      throw new HttpConfigError('redirectHttp requires a TCP listener.');
    }
    const host = options.redirectHttp.host;
    if (host === undefined) {
      this.logger.warn(
        'redirectHttp has no host, so redirects follow the Host header the client sent. Set ' +
          "redirectHttp: { host: 'example.com' } to always redirect to the canonical host.",
      );
    }
    const origin = host === undefined ? undefined : canonicalOrigin(host, httpsPort);
    return Bun.serve({
      port: options.redirectHttp.port,
      hostname: options.redirectHttp.hostname ?? options.hostname ?? '0.0.0.0',
      development: this.development,
      error: this.#serverError,
      fetch: (req) => {
        if (origin !== undefined) return redirectTo(req, origin);
        if (hosts !== undefined && !hosts(req.headers.get('host'))) {
          return withCacheControl(misdirectedResponse(), this.#defaultCacheControl);
        }
        return redirectToHttps(req, httpsPort);
      },
    });
  }

  /** Bun's `error` handler: a rejection that escaped every handler, answered as a masked 500. */
  readonly #serverError = (error: Error): Response =>
    withCacheControl(
      internalErrorResponse(error, this, 'Unhandled error reached the server'),
      this.#defaultCacheControl,
    );

  /** Global middleware, guards and filters are compiled by listen(): later calls would be lost. */
  #assertNotListening(method: string): void {
    if (this.#server || this.#pendingListen || this.#closing) {
      throw new HttpConfigError(`${method}() must be called before listen() and close().`);
    }
  }
}
