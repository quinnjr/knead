import {
  getMetadata,
  getMethodMetadata,
  inject,
  MODULES,
  type ModuleInjector,
  type ModuleRef,
  type OnModuleDestroy,
  type OnModuleInit,
  type Type,
} from '@hpmws/core';
import {
  BadRequestException,
  type Ctx,
  ForbiddenException,
  GUARDS,
  type Guard,
  type GuardRef,
  HTTP_DEVELOPMENT,
  LOGGER,
  ROUTE_META,
  WsRegistry,
  type WsSocket,
} from '@hpmws/http';
import {
  type CompilerOptions,
  type ExecutionHooks,
  type ExecutionResult,
  type ExecutorConfig,
  type GraphQLRequest,
  type GraphQLResponse,
  LeavenExecutor,
  type SubscriptionIterator,
} from '@leaven-graphql/core';
import { type ErrorCode, LeavenError } from '@leaven-graphql/errors';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type DocumentNode,
  type GraphQLFieldResolver,
  type GraphQLSchema,
  getOperationAST,
  isInterfaceType,
  isObjectType,
  visit,
} from 'graphql';
import {
  createResolverCtx,
  OperationContext,
  type OperationKind,
  type ResolverCtx,
} from './context.js';
import {
  ArgsValidationError,
  type ArgsValidationIssue,
  createErrorFormatter,
  type ErrorMaskingOptions,
  logInternalError,
  MASKED_MESSAGE,
  markResolverError,
  SchemaBuildError,
  toSafeError,
} from './errors.js';
import {
  RESOLVER,
  RESOLVER_METHODS,
  type ResolverMethodDefinition,
  type SubscriptionMethodOptions,
} from './metadata.js';
import {
  GRAPHQL_OPTIONS,
  GRAPHQL_PATH,
  type ResolvedGraphQLOptions,
  resolveOptions,
} from './options.js';
import { PlaygroundGate } from './playground.js';
import { eventIterator, PUBSUB } from './pubsub.js';
import { IS_PUBLIC } from './resolvers.js';
import { argNames, type FieldSpec, printSortedSchema, SchemaBuilder } from './schema.js';
import {
  createSubscriptionEndpoint,
  type GraphQLConnection,
  type SubscriptionEndpoint,
} from './subscriptions.js';
import type { Class } from './type-refs.js';

export interface DiscoveredResolver {
  readonly cls: Type;
  readonly instance: Record<string, unknown>;
  readonly injector: ModuleInjector;
}

/** Every class provider, in every module, whose class carries @Resolver metadata (deduplicated). */
export function discoverResolvers(modules: readonly ModuleRef[]): DiscoveredResolver[] {
  const seen = new Set<Function>();
  const out: DiscoveredResolver[] = [];
  for (const mod of modules) {
    for (const record of mod.injector.ownRecords()) {
      const provider = record.provider;
      if (provider.kind !== 'class' || provider.multi) continue;
      if (seen.has(provider.useClass) || !getMetadata(provider.useClass, RESOLVER)) continue;
      seen.add(provider.useClass);
      out.push({
        cls: provider.useClass,
        instance: mod.injector.get(provider.token) as Record<string, unknown>,
        injector: mod.injector,
      });
    }
  }
  return out;
}

function isClassWith(value: unknown, method: string): value is Type {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: Record<string, unknown> }).prototype?.[method] === 'function'
  );
}

function resolveGuard(ref: GuardRef<any>, injector: ModuleInjector): Guard<any> {
  if (isClassWith(ref, 'canActivate')) return injector.resolveOrConstruct(ref as Type<Guard<any>>);
  if (typeof ref === 'function') return { canActivate: ref as (ctx: unknown) => boolean };
  return ref;
}

/** Rejects computed topics containing a wildcard ("*" or "#") with BAD_USER_INPUT. */
export function rejectWildcards(topics: string | readonly string[]): void {
  for (const topic of typeof topics === 'string' ? [topics] : topics) {
    if (/[*#]/.test(topic)) {
      throw new BadRequestException('Subscription topics cannot contain "*" or "#".');
    }
  }
}

/** Stands in for an event whose rechecked guards denied; its resolver rethrows `error`. */
class RevokedEvent {
  constructor(readonly error: unknown) {}
}

/**
 * Runs `check` before each event of `source`. When it throws, the next value is a RevokedEvent
 * and the iterator then ends (and unsubscribes).
 */
function recheckEvents<T>(
  source: AsyncIterableIterator<T>,
  check: () => Promise<void>,
): AsyncIterableIterator<T | RevokedEvent> {
  let revoked = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (revoked) {
        await source.return?.();
        return { value: undefined, done: true };
      }
      const result = await source.next();
      if (result.done) return result;
      try {
        await check();
      } catch (error) {
        revoked = true;
        return { value: new RevokedEvent(error), done: false };
      }
      return result;
    },
    async return() {
      await source.return?.();
      return { value: undefined, done: true };
    },
    async throw(error?: unknown) {
      await source.return?.();
      throw error;
    },
  };
}

/** The guard defaultDeny puts on a root field that has no guard of its own. */
const DENY: Guard<unknown> = { canActivate: () => false };

async function runGuards(guards: readonly Guard<any>[], ctx: ResolverCtx<any, any>): Promise<void> {
  for (const guard of guards) {
    // Only `true` passes: a truthy object, string or number is a denial, as in the http pipeline.
    if ((await guard.canActivate(ctx)) !== true) throw new ForbiddenException();
  }
}

function segment(s: PropertyKey | StandardSchemaV1.PathSegment): string {
  return String(typeof s === 'object' ? s.key : s);
}

async function validateArgs(
  schemas: Readonly<Record<string, StandardSchemaV1>> | undefined,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!schemas) return args;
  const out = { ...args };
  const issues: ArgsValidationIssue[] = [];
  for (const [arg, schema] of Object.entries(schemas)) {
    const result = await schema['~standard'].validate(args[arg]);
    if (result.issues) {
      for (const issue of result.issues) {
        issues.push({ arg, message: issue.message, path: (issue.path ?? []).map(segment) });
      }
    } else out[arg] = result.value;
  }
  if (issues.length > 0) throw new ArgsValidationError(issues);
  return out;
}

/** Field cost by field name for Leaven's complexity calculator (max across types sharing a name). */
export function complexityCalculator(
  schema: GraphQLSchema,
): CompilerOptions['complexityCalculator'] | undefined {
  const costs = new Map<string, number>();
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) && !isInterfaceType(type)) continue;
    for (const field of Object.values(type.getFields())) {
      const cost = field.extensions?.complexity;
      if (typeof cost === 'number')
        costs.set(field.name, Math.max(costs.get(field.name) ?? 0, cost));
    }
  }
  if (costs.size === 0) return undefined;
  return (field, depth) => (costs.get(field.name.value) ?? 1) + depth * 0.5;
}

/** Messages for an operation the transport does not carry. */
export function rejectionMessage(
  operation: OperationKind,
  allowed: readonly OperationKind[],
): string {
  if (allowed.length === 1 && allowed[0] === 'subscription') {
    return 'Only subscription operations are allowed over WebSocket.';
  }
  if (operation === 'subscription') return 'Subscriptions are only available over WebSocket.';
  return `A ${operation} cannot be sent over GET; use POST.`;
}

/**
 * Leaven hooks: an onExecute check that the operation Leaven is about to run (from the document
 * it parsed, validated and cached) is allowed on this transport, then the user's hooks with
 * their errors made safe.
 */
export function buildHooks(
  user: ExecutionHooks | undefined,
  masking: ErrorMaskingOptions,
  maxAliases: number | false = false,
): ExecutionHooks {
  const safe = <A extends unknown[]>(
    name: string,
    fn: ((...args: A) => void | Promise<void>) | undefined,
  ) =>
    fn &&
    (async (...args: A) => {
      try {
        await fn(...args);
      } catch (error) {
        throw toSafeError(error, masking, `hooks.${name}`);
      }
    });
  const userExecute = safe('onExecute', user?.onExecute);
  const userParsed = safe('onParsed', user?.onParsed);
  const userError = user?.onError;
  return {
    onParse: safe('onParse', user?.onParse),
    // Runs for cached documents too, so the alias limit holds whatever the cache contains.
    onParsed: async (document: DocumentNode) => {
      if (maxAliases !== false) checkAliases(document, maxAliases);
      await userParsed?.(document);
    },
    onValidate: safe('onValidate', user?.onValidate),
    onValidated: safe('onValidated', user?.onValidated),
    onExecuted: safe('onExecuted', user?.onExecuted),
    onCacheError: user?.onCacheError,
    onError: userError
      ? async (error) => {
          try {
            await userError(error);
          } catch (hookError) {
            logInternalError(masking, 'GraphQL hooks.onError threw', hookError);
          }
        }
      : undefined,
    onExecute: async (context: unknown, document: DocumentNode) => {
      if (context instanceof OperationContext) {
        const operation = getOperationAST(document, context.operationName ?? null)?.operation;
        if (operation && !context.allowedOperations.includes(operation)) {
          context.rejectedOperation = operation;
          throw new LeavenError(
            rejectionMessage(operation, context.allowedOperations),
            'BAD_USER_INPUT' as ErrorCode,
            { statusCode: 400 },
          );
        }
      }
      await userExecute?.(context, document);
    },
  };
}

/** Rejects a document with more than `max` field aliases (counted once per alias in the text). */
export function checkAliases(document: DocumentNode, max: number): void {
  let count = 0;
  visit(document, {
    Field(node) {
      if (node.alias) count++;
    },
  });
  if (count > max) {
    throw new LeavenError(
      `The document has ${count} aliases; at most ${max} are allowed.`,
      'BAD_USER_INPUT' as ErrorCode,
      { statusCode: 400 },
    );
  }
}

const OPERATION_NOT_FOUND = /^Operation "(.*)" not found(?: in document)?$/;

/**
 * Leaven reports anything non-GraphQL thrown inside its pipeline (a failing custom cache, a
 * compiler error) as INTERNAL_ERROR with the raw message. The two client mistakes among them, a
 * missing or unknown operation name, become BAD_USER_INPUT as graphql-js reports them; every
 * other INTERNAL_ERROR is logged and becomes INTERNAL_SERVER_ERROR, masked when `maskErrors`.
 */
export function normalizeResponse<T>(
  response: GraphQLResponse<T>,
  masking: ErrorMaskingOptions,
): GraphQLResponse<T> {
  if (!response.errors?.some((e) => e.extensions?.code === 'INTERNAL_ERROR')) return response;
  const errors = response.errors.map((error) => {
    if (error.extensions?.code !== 'INTERNAL_ERROR') return error;
    const named = OPERATION_NOT_FOUND.exec(error.message);
    const message =
      error.message === 'No operation found in document'
        ? 'Must provide operation name if query contains multiple operations.'
        : named
          ? `Unknown operation named "${named[1]}".`
          : undefined;
    if (message) {
      return { ...error, message, extensions: { ...error.extensions, code: 'BAD_USER_INPUT' } };
    }
    const correlationId = logInternalError(
      masking,
      'GraphQL execution failed inside Leaven',
      error,
    );
    return {
      ...error,
      message: masking.maskErrors ? MASKED_MESSAGE : error.message,
      extensions: { code: 'INTERNAL_SERVER_ERROR', correlationId },
    };
  });
  return { ...response, errors };
}

/** LeavenExecutor whose request-level errors are normalized (used for HTTP and WebSocket). */
export class GraphQLExecutor extends LeavenExecutor {
  readonly #masking: ErrorMaskingOptions;

  constructor(config: ExecutorConfig, masking: ErrorMaskingOptions) {
    super(config);
    this.#masking = masking;
  }

  override async execute<TData = Record<string, unknown>, TContext = unknown>(
    request: GraphQLRequest,
    context?: TContext,
  ): Promise<ExecutionResult<TData>> {
    const result = await super.execute<TData, TContext>(request, context);
    return { ...result, response: normalizeResponse(result.response, this.#masking) };
  }

  override async subscribe<TData = Record<string, unknown>, TContext = unknown>(
    request: GraphQLRequest,
    context?: TContext,
  ): Promise<SubscriptionIterator<TData> | GraphQLResponse<TData>> {
    const result = await super.subscribe<TData, TContext>(request, context);
    return Symbol.asyncIterator in result ? result : normalizeResponse(result, this.#masking);
  }
}

/** Owns the schema, the Leaven executor and the subscription endpoint. */
export class GraphQLRuntime implements OnModuleInit, OnModuleDestroy {
  readonly options: ResolvedGraphQLOptions = resolveOptions(
    inject(GRAPHQL_OPTIONS),
    inject(GRAPHQL_PATH),
  );
  readonly pubsub = inject(PUBSUB);
  readonly logger = inject(LOGGER);
  /** The application's development flag (HTTP_DEVELOPMENT), else NODE_ENV === 'development'. */
  readonly development: boolean =
    inject(HTTP_DEVELOPMENT, { optional: true }) ?? process.env.NODE_ENV === 'development';
  readonly #modules = inject(MODULES);
  readonly #ws = inject(WsRegistry);
  #schema: GraphQLSchema | undefined;
  #executor: LeavenExecutor | undefined;
  #playground: PlaygroundGate | undefined;
  #endpoint: SubscriptionEndpoint | undefined;

  get schema(): GraphQLSchema {
    if (!this.#schema)
      throw new SchemaBuildError('The GraphQL schema is built during onModuleInit.');
    return this.#schema;
  }

  get executor(): LeavenExecutor {
    if (!this.#executor)
      throw new SchemaBuildError('The GraphQL executor is built during onModuleInit.');
    return this.#executor;
  }

  /** Present when `playground` is enabled; its asset hashes were checked at bootstrap. */
  get playground(): PlaygroundGate {
    if (!this.#playground) throw new SchemaBuildError('The GraphQL playground is not enabled.');
    return this.#playground;
  }

  get masking(): ErrorMaskingOptions {
    return {
      maskErrors: this.options.maskErrors,
      logger: this.logger,
      development: this.development,
    };
  }

  /** The GraphQL connection of a subscription socket, or undefined for any other socket. */
  connection(ws: WsSocket): GraphQLConnection | undefined {
    return this.#endpoint?.connection(ws);
  }

  get subscriptionsEnabled(): boolean {
    return this.options.subscriptions !== false && this.schema.getSubscriptionType() !== undefined;
  }

  async onModuleInit(): Promise<void> {
    this.#schema = this.#build();
    const calculator = complexityCalculator(this.#schema);
    const { compilerOptions, hooks, ...executor } = this.options.executor;
    this.#executor = new GraphQLExecutor(
      {
        ...executor,
        schema: this.#schema,
        introspection: this.options.introspection,
        compilerOptions: calculator
          ? { complexityCalculator: calculator, ...compilerOptions }
          : compilerOptions,
        hooks: buildHooks(hooks, this.masking, this.options.maxAliases),
        formatExecutionError: createErrorFormatter(this.masking),
      },
      this.masking,
    );
    (this.pubsub as { useLogger?: (logger: unknown) => void }).useLogger?.(this.logger);
    if (this.options.playground) {
      this.#playground = new PlaygroundGate(this.logger);
      if (!this.development) {
        this.logger.warn(
          'The GraphQL playground is enabled outside development: it exposes the schema ' +
            '(introspection follows it) to anyone who can reach the endpoint.',
        );
      }
    }
    if (this.options.emitSchemaFile !== false) {
      await Bun.write(this.options.emitSchemaFile, printSortedSchema(this.#schema));
    }
    const subscriptions = this.options.subscriptions;
    if (subscriptions !== false && this.#schema.getSubscriptionType()) {
      this.#endpoint = createSubscriptionEndpoint(this, subscriptions);
      this.#ws.register(this.options.path, this.#endpoint, {
        allowedOrigins: subscriptions.allowedOrigins,
        messageRate: subscriptions.messageRate,
        maxConnectionLifetime: subscriptions.maxConnectionLifetime,
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    const close = (this.pubsub as { close?: () => unknown }).close;
    if (typeof close === 'function') await close.call(this.pubsub);
  }

  /**
   * One context per operation: the user `context` factory result plus `extra` (onConnect).
   * `allowed` lists the operation types this transport may execute.
   */
  async createOperationContext(
    http: Ctx,
    allowed: readonly OperationKind[],
    extra?: object,
  ): Promise<OperationContext> {
    const user = this.options.context ? await this.options.context(http) : {};
    return new OperationContext(http, { ...user, ...extra }, allowed);
  }

  #build(): GraphQLSchema {
    const query: FieldSpec[] = [];
    const mutation: FieldSpec[] = [];
    const subscription: FieldSpec[] = [];
    const typeFields = new Map<Class, FieldSpec[]>();
    const types: Class[] = [...this.options.orphanedTypes];
    for (const resolver of discoverResolvers(this.#modules)) {
      const target = getMetadata(resolver.cls, RESOLVER)?.type?.();
      for (const def of getMetadata(resolver.cls, RESOLVER_METHODS) ?? []) {
        const spec = this.#spec(resolver, def);
        if (def.kind === 'query') query.push(spec);
        else if (def.kind === 'mutation') mutation.push(spec);
        else if (def.kind === 'subscription') subscription.push(spec);
        else {
          if (!target) {
            throw new SchemaBuildError(
              `${spec.owner}: @ResolveField() requires @Resolver(() => Type) on ${resolver.cls.name}.`,
            );
          }
          const list = typeFields.get(target) ?? [];
          const clash = list.find((s) => s.name === spec.name);
          if (clash) {
            throw new SchemaBuildError(
              `Duplicate field ${target.name}.${spec.name}: ${clash.owner} and ${spec.owner}.`,
            );
          }
          list.push(spec);
          typeFields.set(target, list);
          if (!types.includes(target)) types.push(target);
        }
      }
    }
    return new SchemaBuilder({ query, mutation, subscription, typeFields, types }).build();
  }

  #spec(resolver: DiscoveredResolver, def: ResolverMethodDefinition): FieldSpec {
    const { cls, instance, injector } = resolver;
    const owner = `${cls.name}.${def.method}`;
    const method = instance[def.method];
    if (typeof method !== 'function') throw new SchemaBuildError(`${owner} is not a method.`);
    const options = def.options;
    const declared = argNames(options.args);
    for (const key of Object.keys(options.validate ?? {})) {
      if (!declared.includes(key)) {
        throw new SchemaBuildError(`${owner}: validate.${key} does not match a declared argument.`);
      }
    }
    const meta = Object.freeze({
      ...(getMetadata(cls, ROUTE_META) ?? {}),
      ...(options.meta ?? {}),
      ...(getMethodMetadata(cls, def.method, ROUTE_META) ?? {}),
    });
    const own = [
      ...(getMetadata(cls, GUARDS) ?? []),
      ...(options.guards ?? []),
      ...(getMethodMetadata(cls, def.method, GUARDS) ?? []),
    ];
    // Module guards and defaultDeny apply to root fields (not @ResolveField) unless @Public().
    const root = def.kind !== 'field' && meta[IS_PUBLIC] !== true;
    const denied = root && this.options.defaultDeny && own.length === 0;
    const guards = [...(denied ? [DENY] : []), ...(root ? this.options.guards : []), ...own].map(
      (ref) => resolveGuard(ref, injector),
    );
    const call = (ctx: ResolverCtx<any, any>) =>
      (method as (c: unknown) => unknown).call(instance, ctx);
    const prepare = async (
      parent: unknown,
      args: Record<string, unknown>,
      op: OperationContext,
      info: Parameters<GraphQLFieldResolver<unknown, unknown>>[3],
      guarded: boolean,
    ) => {
      const ctx = createResolverCtx(op, injector, meta, args, parent, info);
      if (guarded) await runGuards(guards, ctx);
      ctx.args = await validateArgs(options.validate, args);
      return ctx;
    };
    const spec: FieldSpec = {
      name: options.name ?? def.method,
      owner,
      type: def.type,
      nullable: options.nullable,
      description: options.description,
      deprecationReason: options.deprecationReason,
      complexity: options.complexity,
      args: options.args,
    };
    // Errors from resolver code are marked so the formatter can tell them from graphql-js's own.
    const marked =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        try {
          return await fn(...args);
        } catch (error) {
          throw markResolverError(error);
        }
      };
    if (def.kind !== 'subscription') {
      spec.resolve = marked(async (parent, args, op: OperationContext, info) =>
        call(await prepare(parent, args, op, info, true)),
      );
      return spec;
    }
    const sub = options as SubscriptionMethodOptions;
    spec.subscribe = marked(async (parent, args, op: OperationContext, info) => {
      const ctx = await prepare(parent, args, op, info, true);
      const topics = typeof sub.topic === 'function' ? sub.topic(ctx) : sub.topic;
      // A computed topic usually embeds client input; a wildcard there would let the client
      // listen to other topics on engines that support patterns.
      if (typeof sub.topic === 'function') rejectWildcards(topics);
      const filter = sub.filter;
      let warned = false;
      const events = eventIterator(
        this.pubsub,
        typeof topics === 'string' ? [topics] : [...topics],
        filter
          ? async (payload) => {
              try {
                return await filter({ payload, args: ctx.args, ctx });
              } catch (error) {
                throw toSafeError(error, this.masking, `${owner} filter`);
              }
            }
          : undefined,
        {
          onDrop: () => {
            if (warned) return;
            warned = true;
            this.logger.warn(
              `${owner}: a slow subscriber is dropping events (queue limit reached).`,
            );
          },
        },
      );
      if (!sub.recheckGuards) return events;
      return recheckEvents(events, () =>
        runGuards(guards, createResolverCtx(op, injector, meta, ctx.args, parent, info)),
      );
    });
    spec.resolve = marked(async (payload, args, op: OperationContext, info) => {
      if (payload instanceof RevokedEvent) throw payload.error;
      op.resetForEvent();
      const value = sub.resolve ? await sub.resolve(payload) : payload;
      const result = await call(await prepare(value, args, op, info, false));
      return result === undefined ? value : result;
    });
    return spec;
  }
}
