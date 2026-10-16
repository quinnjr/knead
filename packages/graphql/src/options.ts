import { InjectionToken } from '@hpmws/core';
import { type Ctx, type GuardRef, HttpConfigError, type WsMessageRate } from '@hpmws/http';
import type {
  CompilerOptions,
  ExecutionHooks,
  ExecutorConfig,
  ParseOptions,
} from '@leaven-graphql/core';
import type { PubSubEngine } from '@leaven-graphql/ws';
import type { ResolverCtx } from './context.js';
import type { Class } from './type-refs.js';

export interface SubscriptionOptions {
  /**
   * Runs on `connection_init` with the upgrade request's Ctx. `false` closes the socket with
   * 4403; an object is merged into every operation's context on that socket.
   */
  onConnect?: (
    http: Ctx,
    connectionParams: Record<string, unknown>,
  ) => boolean | object | Promise<boolean | object>;
  /** ms to wait for `connection_init` (Leaven default 3000). */
  connectionInitTimeout?: number;
  /** ms between server pings; 0 disables (Leaven default 12000). */
  keepAliveInterval?: number;
  /** Leaven default 100. */
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

export interface GraphQLModuleOptions {
  /** Default '/graphql'. Also the WebSocket path for subscriptions. */
  path?: string;
  /** Builds the user part of each operation's context; merged onto ResolverCtx. */
  context?: (http: Ctx) => object | Promise<object>;
  /** Default: NODE_ENV === 'development'. */
  playground?: boolean;
  /** Default: NODE_ENV === 'development', or true when `playground: true`. */
  introspection?: boolean;
  /** Deepest selection allowed (fragments expanded). Default 10; `Infinity` or `false` disables. */
  maxDepth?: number | false;
  /** Highest query cost allowed (see `complexity`). Default 1000; `Infinity` or `false` disables. */
  maxComplexity?: number | false;
  /**
   * Longest query string, in characters, accepted over HTTP and WebSocket (checked before
   * parsing). Default 100 KiB (102400); `Infinity` or `false` disables.
   */
  maxQueryLength?: number | false;
  /** Most field aliases in one document. Default 30; `Infinity` or `false` disables. */
  maxAliases?: number | false;
  cache?: ExecutorConfig['cache'];
  compilerOptions?: CompilerOptions;
  /** Leaven parser options. `maxTokens` defaults to 10000; `Infinity` disables it. */
  parseOptions?: ParseOptions;
  /** Leaven execution hooks (Leaven has no plugin system; these are its extension point). */
  hooks?: ExecutionHooks;
  /** GET requests must carry one of `requiredHeaders` (default ['x-graphql-request']). */
  csrf?: { requiredHeaders?: readonly string[] } | false;
  /** Default: NODE_ENV !== 'development'. */
  maskErrors?: boolean;
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
  readonly introspection: boolean;
  readonly maskErrors: boolean;
  readonly emitSchemaFile: string | false;
  readonly csrf: { readonly requiredHeaders: readonly string[] } | false;
  readonly subscriptions: SubscriptionOptions | false;
  readonly orphanedTypes: readonly Class[];
  readonly guards: readonly GuardRef<ResolverCtx<any, any>>[];
  readonly defaultDeny: boolean;
  readonly maxQueryLength: number | false;
  readonly maxAliases: number | false;
  readonly executor: Pick<
    ExecutorConfig,
    'maxDepth' | 'maxComplexity' | 'cache' | 'compilerOptions' | 'parseOptions' | 'hooks'
  >;
}

/** Default limits; each can be raised, or disabled with `Infinity` or `false`. */
export const GRAPHQL_LIMITS = Object.freeze({
  maxDepth: 10,
  maxComplexity: 1000,
  maxTokens: 10_000,
  maxQueryLength: 100 * 1024,
  maxAliases: 30,
});

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

export function validateGraphQLOptions(options: GraphQLModuleOptions): void {
  if (options.path !== undefined && /[:*]/.test(options.path)) {
    throw new HttpConfigError(`GraphQL path must be exact; got ${options.path}`);
  }
  limit('maxDepth', options.maxDepth, 1);
  limit('maxComplexity', options.maxComplexity, 1);
  limit('maxQueryLength', options.maxQueryLength, 1);
  limit('maxAliases', options.maxAliases, 1);
  limit('parseOptions.maxTokens', options.parseOptions?.maxTokens, 1);
  const csrf = options.csrf;
  if (csrf && csrf.requiredHeaders !== undefined && csrf.requiredHeaders.length === 0) {
    throw new HttpConfigError(
      'csrf.requiredHeaders must list at least one header; use csrf: false to disable the check.',
    );
  }
}

export function resolveOptions(
  options: GraphQLModuleOptions,
  path: string,
  env: string | undefined = process.env.NODE_ENV,
): ResolvedGraphQLOptions {
  validateGraphQLOptions(options);
  const dev = env === 'development';
  const maxDepth = limit('maxDepth', options.maxDepth, GRAPHQL_LIMITS.maxDepth);
  const maxComplexity = limit('maxComplexity', options.maxComplexity, GRAPHQL_LIMITS.maxComplexity);
  return {
    path,
    context: options.context,
    playground: options.playground ?? dev,
    introspection: options.introspection ?? (dev || options.playground === true),
    maskErrors: options.maskErrors ?? !dev,
    emitSchemaFile: options.emitSchemaFile ?? (dev ? 'schema.graphql' : false),
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
    executor: {
      maxDepth: maxDepth === false ? undefined : maxDepth,
      maxComplexity: maxComplexity === false ? undefined : maxComplexity,
      cache: options.cache,
      compilerOptions: options.compilerOptions,
      parseOptions: parseOptionsWithDefaults(options.parseOptions),
      hooks: options.hooks,
    },
  };
}
