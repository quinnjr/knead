import { InjectionToken } from '@hpmws/core';
import { type Ctx, HttpConfigError } from '@hpmws/http';
import type {
  CompilerOptions,
  ExecutionHooks,
  ExecutorConfig,
  ParseOptions,
} from '@leaven-graphql/core';
import type { PubSubEngine } from '@leaven-graphql/ws';
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
  maxDepth?: number;
  maxComplexity?: number;
  cache?: ExecutorConfig['cache'];
  compilerOptions?: CompilerOptions;
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
  readonly executor: Pick<
    ExecutorConfig,
    'maxDepth' | 'maxComplexity' | 'cache' | 'compilerOptions' | 'parseOptions' | 'hooks'
  >;
}

export const GRAPHQL_OPTIONS = new InjectionToken<GraphQLModuleOptions>('GRAPHQL_OPTIONS');
export const GRAPHQL_PATH = new InjectionToken<string>('GRAPHQL_PATH');

export function normalizePath(path: string): string {
  return `/${path
    .split('/')
    .filter((s) => s.length > 0)
    .join('/')}`;
}

export function validateGraphQLOptions(options: GraphQLModuleOptions): void {
  if (options.path !== undefined && /[:*]/.test(options.path)) {
    throw new HttpConfigError(`GraphQL path must be exact; got ${options.path}`);
  }
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
    executor: {
      maxDepth: options.maxDepth,
      maxComplexity: options.maxComplexity,
      cache: options.cache,
      compilerOptions: options.compilerOptions,
      parseOptions: options.parseOptions,
      hooks: options.hooks,
    },
  };
}
