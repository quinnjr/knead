import type { ModuleOptions, Provider, Token, Type } from '@hpmws/core';
import {
  type ExceptionFilter,
  type Guard,
  HpmwsFactory,
  type HttpApplication,
  type ListenOptions,
  type LogEntry,
  type Logger,
  MemoryLogger,
  type Middleware,
} from '@hpmws/http';

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
    const app = await HpmwsFactory.create(
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
  #testApp: TestApp | undefined;

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

  async createApp(options: ListenOptions = {}): Promise<TestApp> {
    if (this.#testApp) return this.#testApp;
    await this.app.listen({ port: 0, hostname: '127.0.0.1', ...options });
    this.#testApp = new TestApp(this.app);
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
  tls?: { rejectUnauthorized?: boolean };
}

export class TestApp {
  constructor(readonly app: HttpApplication) {}

  get url(): URL {
    return this.app.url;
  }

  request(method: string, path: string, init: TestRequestInit = {}): Promise<Response> {
    const url = new URL(path, this.url);
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

  close(): Promise<void> {
    return this.app.close();
  }
}
