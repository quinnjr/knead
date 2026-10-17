import { InjectionToken } from '@knead-js/core';
import {
  type Ctx,
  type GuardRef,
  HttpConfigError,
  type HttpException,
  isHeaderValue,
  type WsMessageRate,
} from '@knead-js/http';
import type {
  CompilerOptions,
  ExecutionHooks,
  ExecutorConfig,
  ParseOptions,
} from '@leaven-graphql/core';
import type { PubSubEngine } from '@leaven-graphql/ws';
import type { GraphQLContext, ResolverCtx } from './context.js';
import type { Class } from './type-refs.js';

/** Phantom brand on connectionParams, so they cannot be returned from onConnect as the context. */
declare const CONNECTION_PARAMS: unique symbol;

/**
 * The client's `connection_init` payload: untrusted input chosen by the client. Read the fields
 * you need and verify them; never return or spread it into the onConnect result.
 */
export type ConnectionParams = Readonly<Record<string, unknown>> & {
  readonly [CONNECTION_PARAMS]?: true;
};

/** What onConnect may add to the context: GraphQLContext fields, never the raw params. */
export type ConnectContext = Partial<GraphQLContext> & { readonly [CONNECTION_PARAMS]?: never };

export interface SubscriptionOptions {
  /**
   * Runs on `connection_init` with the upgrade request's Ctx. `false` closes the socket with
   * 4403; an object is merged into every operation's context on that socket. Never spread
   * `connectionParams` into the result: the client would choose its own context (`user`,
   * `roles`, ...). Return only values you derived and verified.
   */
  onConnect?: (
    http: Ctx,
    connectionParams: ConnectionParams,
  ) => boolean | ConnectContext | Promise<boolean | ConnectContext>;
  /**
   * Called before every recheck of a `recheckGuards: true` subscription, with the operation's
   * upgrade Ctx and current user context. An object is merged over that context (the guards and
   * the event's resolvers see it); anything else (`false`, but also `undefined`, `null` or
   * `true`) ends the subscription with FORBIDDEN. Without it,
   * rechecked guards see the identity from connect time: use it for a live lookup (for example
   * re-verifying the session) so that a revoked credential ends the subscription.
   */
  refreshContext?: (connection: {
    http: Ctx;
    context: Readonly<Record<PropertyKey, unknown>>;
  }) => ConnectContext | false | Promise<ConnectContext | false>;
  /** ms to wait for `connection_init`, an integer from 1 to 2^31 - 1 (Leaven default 3000). */
  connectionInitTimeout?: number;
  /** ms between server pings, an integer up to 2^31 - 1; 0 disables (Leaven default 12000). */
  keepAliveInterval?: number;
  /** Concurrent subscriptions per socket, a positive integer (Leaven default 100). */
  maxSubscriptionsPerConnection?: number;
  /**
   * Browser origins allowed to open a subscription socket, besides the server's own origin
   * (default: same origin only). `'*'` allows any origin. Upgrades without an Origin header
   * (non-browser clients) are always allowed. Others are rejected with 403.
   */
  allowedOrigins?: readonly string[] | '*';
  /**
   * Per-socket message rate for the subscription endpoint (a token bucket; exceeding it closes
   * the socket with 1008). `false` disables it. Default: the server's `listen({ websocket })`
   * `messageRate`, 100 messages per 10s.
   */
  messageRate?: WsMessageRate | false;
  /**
   * Milliseconds after which every subscription socket is closed with 4408, so that clients
   * reconnect and pass `onConnect` again. Default: no limit.
   */
  maxConnectionLifetime?: number;
}

export interface PlaygroundOptions {
  subscriptionEndpoint?: string;
}

export interface GraphQLModuleOptions {
  /** Default '/graphql'. Also the WebSocket path for subscriptions. */
  path?: string;
  /**
   * Builds the user part of each operation's context, spread into each ResolverCtx. The built-in
   * members (`args`, `parent`, `info`, `http`, `state`, `meta`, `loader`) win over context keys
   * with the same name, so do not use those names.
   */
  context?: (http: Ctx) => object | Promise<object>;
  /**
   * Serves GraphQL Playground to browsers. Default: the application is in development (the
   * HTTP_DEVELOPMENT flag). An object enables
   * it with options: `subscriptionEndpoint` is the WebSocket URL the page connects to (a
   * `ws://`/`wss://` URL or an absolute path; a URL's origin is added to the page's CSP
   * `connect-src`). Without it, the URL is derived from the request's Host header when that is a
   * plain `host[:port]`, and is the relative path otherwise.
   */
  playground?: boolean | PlaygroundOptions;
  /** Default: true in development (HTTP_DEVELOPMENT), or when the playground is on. */
  introspection?: boolean;
  /**
   * Deepest selection allowed (fragments expanded). Selections inside `__schema` and `__type`
   * do not count, so introspection works; `maxIntrospectionDepth` caps them. Default 10;
   * `Infinity` or `false` disables.
   */
  maxDepth?: number | false;
  /**
   * Deepest selection inside `__schema` or `__type`, counting that field as level 1 (fragments
   * expanded). Default 20, headroom above graphql-js's `getIntrospectionQuery()` (15);
   * `Infinity` or `false` disables.
   */
  maxIntrospectionDepth?: number | false;
  /** Highest query cost allowed (see `complexity`). Default 1000; `Infinity` or `false` disables. */
  maxComplexity?: number | false;
  /**
   * Longest query string, in characters, accepted over HTTP and WebSocket (checked before
   * parsing). Default 100 KiB (102400); `Infinity` or `false` disables.
   */
  maxQueryLength?: number | false;
  /** Most field aliases in one document. Default 30; `Infinity` or `false` disables. */
  maxAliases?: number | false;
  /**
   * Most field selections in one document, fragments expanded where they are spread (FIELD_LIMIT).
   * Checked right after parsing, before validation (whose overlapping-fields rule is quadratic in
   * repeated fields) and before the document is cached. Default 1000; `Infinity` or `false`
   * disables.
   */
  maxFields?: number | false;
  /**
   * Leaven's parsed-document cache. Default `{ maxSize: 100 }` documents; `false` disables it.
   * Every entry keeps the document's AST, so keep it small.
   */
  cache?: ExecutorConfig['cache'];
  compilerOptions?: CompilerOptions;
  /** Leaven parser options. `maxTokens` defaults to 3000; `Infinity` disables it. */
  parseOptions?: ParseOptions;
  /** Leaven execution hooks (Leaven has no plugin system; these are its extension point). */
  hooks?: ExecutionHooks;
  /**
   * Cache-Control of GraphQL responses (a valid header value, checked at bootstrap). Default
   * 'no-store' (responses often carry per-user data); `false` sends none.
   */
  cacheControl?: string | false;
  /**
   * GET requests must carry one of `requiredHeaders` (header names; default
   * ['x-graphql-request']).
   */
  csrf?: { requiredHeaders?: readonly string[] } | false;
  /** Default: true outside development (HTTP_DEVELOPMENT). */
  maskErrors?: boolean;
  /**
   * Maps an error thrown by resolver code, `hooks`, subscription filters or the `context` factory
   * over WebSocket to an HttpException before masking; return undefined to leave it as is.
   */
  mapError?: (error: unknown) => HttpException | undefined;
  /** Writes sorted SDL at bootstrap. Default: 'schema.graphql' in development, else false. */
  emitSchemaFile?: string | false;
  /** Types not reachable from any resolver (e.g. interface implementations). */
  orphanedTypes?: readonly Class[];
  /** Default: enabled when the schema has subscriptions. */
  subscriptions?: SubscriptionOptions | false;
  /** Default: Leaven's in-memory PubSub. Closed on shutdown if it has close(). */
  pubsub?: PubSubEngine;
  /**
   * Guards run on every root field (query, mutation and subscription), before the resolver's
   * class and method guards. `@Public()` resolvers skip them. Not run for `@ResolveField`.
   */
  guards?: readonly GuardRef<ResolverCtx<any, any>>[];
  /**
   * Deny (FORBIDDEN) every root field that is neither `@Public()` nor protected by a guard of
   * its own (class `@UseGuards`, the `guards` option or method `@UseGuards`); module `guards`
   * do not count. Default false.
   */
  defaultDeny?: boolean;
}

export interface ResolvedGraphQLOptions {
  readonly path: string;
  readonly context: GraphQLModuleOptions['context'];
  readonly playground: boolean;
  /** The playground's configured subscription endpoint, if any. */
  readonly playgroundSubscriptionEndpoint: string | undefined;
  readonly introspection: boolean;
  readonly maskErrors: boolean;
  readonly mapError: ((error: unknown) => HttpException | undefined) | undefined;
  readonly emitSchemaFile: string | false;
  readonly csrf: { readonly requiredHeaders: readonly string[] } | false;
  readonly cacheControl: string | false;
  readonly subscriptions: SubscriptionOptions | false;
  readonly orphanedTypes: readonly Class[];
  readonly guards: readonly GuardRef<ResolverCtx<any, any>>[];
  readonly defaultDeny: boolean;
  readonly maxQueryLength: number | false;
  readonly maxAliases: number | false;
  readonly maxFields: number | false;
  readonly maxIntrospectionDepth: number | false;
  /** Checked by Knead (introspection fields excluded); Leaven's own maxDepth stays unset. */
  readonly maxDepth: number | false;
  readonly executor: Pick<
    ExecutorConfig,
    'maxDepth' | 'maxComplexity' | 'cache' | 'compilerOptions' | 'parseOptions' | 'hooks'
  >;
}

/** Default limits; each can be raised, or disabled with `Infinity` or `false`. */
export const GRAPHQL_LIMITS = Object.freeze({
  maxDepth: 10,
  maxComplexity: 1000,
  maxTokens: 3000,
  maxQueryLength: 100 * 1024,
  maxAliases: 30,
  maxFields: 1000,
  maxIntrospectionDepth: 20,
});

/** Default Leaven document cache: at most 100 parsed documents. */
export const DEFAULT_DOCUMENT_CACHE = Object.freeze({ maxSize: 100 });

/** The client error for a query over `maxQueryLength`. */
export function queryTooLongMessage(max: number): string {
  return `The query is longer than ${max} characters.`;
}

export const GRAPHQL_OPTIONS = new InjectionToken<GraphQLModuleOptions>('GRAPHQL_OPTIONS');
export const GRAPHQL_PATH = new InjectionToken<string>('GRAPHQL_PATH');

export function normalizePath(path: string): string {
  return `/${path
    .split('/')
    .filter((s) => s.length > 0)
    .join('/')}`;
}

function limit(name: string, value: number | false | undefined, fallback: number): number | false {
  if (value === undefined) return fallback;
  if (value === false || value === Infinity) return false;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new HttpConfigError(
      `GraphQL ${name} must be a positive integer, Infinity or false; got ${String(value)}.`,
    );
  }
  return value;
}

function parseOptionsWithDefaults(options: ParseOptions | undefined): ParseOptions {
  const { maxTokens, ...rest } = options ?? {};
  const tokens = limit('parseOptions.maxTokens', maxTokens, GRAPHQL_LIMITS.maxTokens);
  return tokens === false ? rest : { ...rest, maxTokens: tokens };
}

/** An RFC 9110 header field name (a token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Longest timer delay setTimeout/setInterval honour; larger values fire after 1 ms. */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

function subscriptionInteger(
  name: string,
  value: number | undefined,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpConfigError(
      `GraphQL subscriptions.${name} must be an integer from ${min} to ${max}; got ${String(value)}.`,
    );
  }
}

export function validateGraphQLOptions(options: GraphQLModuleOptions): void {
  if (options.path !== undefined && /[:*]/.test(options.path)) {
    throw new HttpConfigError(`GraphQL path must be exact; got ${options.path}`);
  }
  limit('maxDepth', options.maxDepth, 1);
  limit('maxComplexity', options.maxComplexity, 1);
  limit('maxQueryLength', options.maxQueryLength, 1);
  limit('maxAliases', options.maxAliases, 1);
  limit('maxFields', options.maxFields, 1);
  limit('maxIntrospectionDepth', options.maxIntrospectionDepth, 1);
  limit('parseOptions.maxTokens', options.parseOptions?.maxTokens, 1);
  const endpoint =
    typeof options.playground === 'object' ? options.playground.subscriptionEndpoint : undefined;
  if (endpoint !== undefined && !/^(?:wss?:\/\/[^\s"'<>]+|\/[^\s"'<>]*)$/i.test(endpoint)) {
    throw new HttpConfigError(
      `playground.subscriptionEndpoint must be a ws:// or wss:// URL or an absolute path; got ${JSON.stringify(endpoint)}`,
    );
  }
  if (options.mapError !== undefined && typeof options.mapError !== 'function') {
    throw new HttpConfigError('GraphQL mapError must be a function.');
  }
  const csrf = options.csrf;
  if (csrf && csrf.requiredHeaders !== undefined && csrf.requiredHeaders.length === 0) {
    throw new HttpConfigError(
      'csrf.requiredHeaders must list at least one header; use csrf: false to disable the check.',
    );
  }
  for (const name of csrf ? (csrf.requiredHeaders ?? []) : []) {
    if (typeof name !== 'string' || !HEADER_NAME.test(name)) {
      throw new HttpConfigError(
        `csrf.requiredHeaders entries must be header names; got ${JSON.stringify(name)}.`,
      );
    }
  }
  const cacheControl = options.cacheControl;
  if (
    cacheControl !== undefined &&
    cacheControl !== false &&
    (typeof cacheControl !== 'string' || !isHeaderValue(cacheControl))
  ) {
    throw new HttpConfigError(
      `GraphQL cacheControl must be a valid header value or false; got ${JSON.stringify(cacheControl)}.`,
    );
  }
  const subscriptions = options.subscriptions;
  if (subscriptions) {
    // Leaven passes the first two to setTimeout/setInterval and compares the count with `>=`.
    subscriptionInteger(
      'connectionInitTimeout',
      subscriptions.connectionInitTimeout,
      1,
      MAX_TIMER_DELAY,
    );
    // 0 disables the pings.
    subscriptionInteger('keepAliveInterval', subscriptions.keepAliveInterval, 0, MAX_TIMER_DELAY);
    subscriptionInteger(
      'maxSubscriptionsPerConnection',
      subscriptions.maxSubscriptionsPerConnection,
      1,
    );
  }
}

export function resolveOptions(
  options: GraphQLModuleOptions,
  path: string,
  /** The application's development flag, or a NODE_ENV value (default: process.env.NODE_ENV). */
  development: boolean | string | undefined = process.env.NODE_ENV,
): ResolvedGraphQLOptions {
  validateGraphQLOptions(options);
  const dev = typeof development === 'boolean' ? development : development === 'development';
  const maxDepth = limit('maxDepth', options.maxDepth, GRAPHQL_LIMITS.maxDepth);
  const maxComplexity = limit('maxComplexity', options.maxComplexity, GRAPHQL_LIMITS.maxComplexity);
  return {
    path,
    context: options.context,
    playground: options.playground === undefined ? dev : options.playground !== false,
    playgroundSubscriptionEndpoint:
      typeof options.playground === 'object' ? options.playground.subscriptionEndpoint : undefined,
    introspection:
      options.introspection ??
      (dev || (options.playground !== undefined && options.playground !== false)),
    maskErrors: options.maskErrors ?? !dev,
    mapError: options.mapError,
    emitSchemaFile: options.emitSchemaFile ?? (dev ? 'schema.graphql' : false),
    cacheControl: options.cacheControl ?? 'no-store',
    csrf:
      options.csrf === false
        ? false
        : {
            requiredHeaders: (options.csrf?.requiredHeaders ?? ['x-graphql-request']).map((h) =>
              h.toLowerCase(),
            ),
          },
    subscriptions: options.subscriptions === false ? false : { ...(options.subscriptions ?? {}) },
    orphanedTypes: options.orphanedTypes ?? [],
    guards: options.guards ?? [],
    defaultDeny: options.defaultDeny ?? false,
    maxQueryLength: limit('maxQueryLength', options.maxQueryLength, GRAPHQL_LIMITS.maxQueryLength),
    maxAliases: limit('maxAliases', options.maxAliases, GRAPHQL_LIMITS.maxAliases),
    maxFields: limit('maxFields', options.maxFields, GRAPHQL_LIMITS.maxFields),
    maxIntrospectionDepth: limit(
      'maxIntrospectionDepth',
      options.maxIntrospectionDepth,
      GRAPHQL_LIMITS.maxIntrospectionDepth,
    ),
    maxDepth,
    executor: {
      // Leaven's depth check counts introspection selections, so getIntrospectionQuery() (depth
      // 15) would fail; runtime.ts runs its own check instead.
      maxDepth: undefined,
      maxComplexity: maxComplexity === false ? undefined : maxComplexity,
      cache: options.cache ?? { ...DEFAULT_DOCUMENT_CACHE },
      compilerOptions: options.compilerOptions,
      parseOptions: parseOptionsWithDefaults(options.parseOptions),
      hooks: options.hooks,
    },
  };
}
