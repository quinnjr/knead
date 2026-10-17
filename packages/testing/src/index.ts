import type { ModuleOptions, Provider, Token, Type } from '@knead-js/core';
import {
  type ExceptionFilter,
  type Guard,
  type HttpApplication,
  KneadFactory,
  type ListenOptions,
  type LogEntry,
  type Logger,
  MemoryLogger,
  type Middleware,
} from '@knead-js/http';
import {
  type GraphQLRequestOptions,
  type GraphQLResult,
  type GraphQLSubscribeOptions,
  type GraphQLSubscription,
  subscribe,
} from './graphql.js';

export type {
  GraphQLErrorJson,
  GraphQLPayload,
  GraphQLRequestOptions,
  GraphQLResult,
  GraphQLSubscribeOptions,
  GraphQLSubscription,
} from './graphql.js';

export interface OverrideBy<T> {
  useValue(value: T): TestingModuleBuilder;
  useClass(cls: Type<T>): TestingModuleBuilder;
  /** Async factories only work for tokens registered as providers. */
  useFactory(factory: () => T | Promise<T>): TestingModuleBuilder;
}

export interface CompileOptions {
  /** Defaults to true so 500 responses include error details. */
  development?: boolean;
  logger?: Logger;
}

export class Test {
  static createModule(metadata: ModuleOptions): TestingModuleBuilder {
    return new TestingModuleBuilder(metadata);
  }
}

export class TestingModuleBuilder {
  readonly #overrides = new Map<Token, Provider>();

  constructor(private readonly metadata: ModuleOptions) {}

  overrideProvider<T>(token: Token<T>): OverrideBy<T> {
    return this.#override<T>(token);
  }

  overrideGuard(guard: Type): OverrideBy<Guard<any>> {
    return this.#override<Guard<any>>(guard);
  }

  overrideMiddleware(middleware: Type): OverrideBy<Middleware> {
    return this.#override<Middleware>(middleware);
  }

  overrideFilter(filter: Type): OverrideBy<ExceptionFilter> {
    return this.#override<ExceptionFilter>(filter);
  }

  async compile(options: CompileOptions = {}): Promise<TestingModule> {
    const logger = options.logger ?? new MemoryLogger();
    const app = await KneadFactory.create(
      { module: class TestRootModule {}, ...this.metadata },
      { overrides: this.#overrides, logger, development: options.development ?? true },
    );
    return new TestingModule(app, logger);
  }

  #override<T>(token: Token): OverrideBy<T> {
    const set = (provider: Provider): TestingModuleBuilder => {
      this.#overrides.set(token, provider);
      return this;
    };
    return {
      useValue: (value) => set({ provide: token, useValue: value }),
      useClass: (cls) => set({ provide: token, useClass: cls }),
      useFactory: (factory) => set({ provide: token, useFactory: factory }),
    };
  }
}

export class TestingModule {
  #testApp: Promise<TestApp> | undefined;

  constructor(
    readonly app: HttpApplication,
    readonly logger: Logger,
  ) {}

  get logs(): readonly LogEntry[] {
    return this.logger instanceof MemoryLogger ? this.logger.entries : [];
  }

  get<T>(token: Token<T>): T {
    return this.app.get(token);
  }

  /**
   * Starts the server on an ephemeral port. Later calls, including concurrent ones, return the
   * same TestApp; a failed start is not cached, so it can be retried.
   */
  createApp(options: ListenOptions = {}): Promise<TestApp> {
    this.#testApp ??= this.app.listen({ port: 0, hostname: '127.0.0.1', ...options }).then(
      () => new TestApp(this.app),
      (error: unknown) => {
        this.#testApp = undefined;
        throw error;
      },
    );
    return this.#testApp;
  }

  close(): Promise<void> {
    return this.app.close();
  }
}

export interface TestRequestInit {
  headers?: Bun.HeadersInit;
  query?: Record<string, string | readonly string[]>;
  /** Serialized with JSON.stringify; sets Content-Type: application/json unless provided. */
  json?: unknown;
  body?: Bun.BodyInit;
  /**
   * TLS options for the test request. `rejectUnauthorized: false` accepts any certificate (for
   * self-signed test certificates): tests only, never in application code.
   */
  tls?: {
    /** `false` skips certificate verification. Tests only. */
    rejectUnauthorized?: boolean;
  };
}

export class TestApp {
  constructor(readonly app: HttpApplication) {}

  get url(): URL {
    return this.app.url;
  }

  /**
   * `path` must start with `/`. It is appended to the test server's origin, so `//other/x` is
   * sent to the test server as the path `//other/x`, never to another host.
   */
  #urlOf(path: string): URL {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new TypeError(`TestApp paths must start with '/', got ${JSON.stringify(path)}`);
    }
    return new URL(this.url.origin + path);
  }

  /** Sends a request to the test server. `path` must start with `/` (see above). */
  async request(method: string, path: string, init: TestRequestInit = {}): Promise<Response> {
    const url = this.#urlOf(path);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      for (const v of typeof value === 'string' ? [value] : value) url.searchParams.append(key, v);
    }
    const headers = new Headers(init.headers);
    let body = init.body;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
    return fetch(url, { method, headers, body, ...(init.tls ? { tls: init.tls } : {}) });
  }

  /**
   * POSTs a GraphQL operation as JSON and returns the parsed body plus status and headers. A
   * response that is not JSON rejects with an Error naming its status and body text.
   */
  async graphql<TData = Record<string, unknown>>(
    query: string,
    options: GraphQLRequestOptions = {},
  ): Promise<GraphQLResult<TData>> {
    const res = await this.request('POST', options.path ?? '/graphql', {
      headers: options.headers,
      json: { query, variables: options.variables, operationName: options.operationName },
      ...(options.tls ? { tls: options.tls } : {}),
    });
    const text = await res.text();
    let body: Omit<GraphQLResult<TData>, 'status' | 'headers'>;
    try {
      body = JSON.parse(text) as Omit<GraphQLResult<TData>, 'status' | 'headers'>;
    } catch {
      const shown = text.length > 1024 ? `${text.slice(0, 1024)}…` : text;
      throw new Error(`GraphQL response is not JSON (status ${res.status}): ${shown}`);
    }
    return { ...body, status: res.status, headers: res.headers };
  }

  /**
   * Opens a graphql-transport-ws connection and subscribes. Resolves after connection_ack; the
   * server may still be registering the subscription, so wait for it before publishing.
   */
  async graphqlSubscribe<TData = Record<string, unknown>>(
    query: string,
    options: GraphQLSubscribeOptions = {},
  ): Promise<GraphQLSubscription<TData>> {
    const url = this.#urlOf(options.path ?? '/graphql');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return subscribe<TData>(url, query, options);
  }

  close(): Promise<void> {
    return this.app.close();
  }
}
