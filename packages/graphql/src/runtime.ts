import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getMetadata,
  getMethodMetadata,
  getOwnMetadata,
  Injectable,
  inject,
  MODULES,
  type ModuleInjector,
  type ModuleRef,
  type OnModuleDestroy,
  type OnModuleInit,
  type Type,
} from '@knead-js/core';
import {
  assertGuardRef,
  BadRequestException,
  type Ctx,
  ForbiddenException,
  GUARDS,
  type Guard,
  HTTP_DEVELOPMENT,
  LOGGER,
  ROUTE_META,
  resolveGuard,
  WsRegistry,
  type WsSocket,
} from '@knead-js/http';
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
import { DepthLimitError, type ErrorCode, LeavenError } from '@leaven-graphql/errors';
import { isRequestError } from '@leaven-graphql/sse';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLFieldResolver,
  type GraphQLSchema,
  getOperationAST,
  isInterfaceType,
  isObjectType,
  Kind,
  type SelectionSetNode,
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
import { FIELD_GUARDS, type FieldGuardSet, guardField } from './field-guards.js';
import {
  RESOLVER,
  RESOLVER_METHODS,
  type ResolverMethodDefinition,
  type SubscriptionMethodOptions,
  TYPE_DEF,
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
import { SseConnections } from './sse.js';
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

/** Longest computed subscription topic, in characters. */
export const MAX_TOPIC_LENGTH = 256;

/** Most distinct topics a computed `topic` may return for one subscription. */
export const MAX_SUBSCRIPTION_TOPICS = 100;

/**
 * Rejects computed topics containing a wildcard ("*" or "#") or longer than 256 characters with
 * BAD_USER_INPUT.
 */
export function rejectWildcards(topics: string | readonly string[]): void {
  for (const topic of typeof topics === 'string' ? [topics] : topics) {
    if (/[*#]/.test(topic)) {
      throw new BadRequestException('Subscription topics cannot contain "*" or "#".');
    }
    if (topic.length > MAX_TOPIC_LENGTH) {
      throw new BadRequestException(
        `Subscription topics cannot be longer than ${MAX_TOPIC_LENGTH} characters.`,
      );
    }
  }
}

/** Stands in for an event whose filter threw or whose rechecked guards denied; its resolver rethrows `error`. */
class RevokedEvent {
  constructor(readonly error: unknown) {}
}

/**
 * Runs `check` before each event of `source`. When it throws, the next value is a RevokedEvent
 * and the iterator then ends (and unsubscribes).
 */
function checkEvents<T>(
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

/** The decorator that declares each TYPE_DEF kind, for error messages. */
const KIND_DECORATOR = {
  object: 'ObjectType',
  interface: 'InterfaceType',
  input: 'InputType',
  args: 'ArgsType',
} as const;

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
export interface DocumentLimits {
  readonly maxAliases?: number | false;
  readonly maxDepth?: number | false;
  readonly maxFields?: number | false;
  readonly maxIntrospectionDepth?: number | false;
}

export function buildHooks(
  user: ExecutionHooks | undefined,
  masking: ErrorMaskingOptions,
  limits: DocumentLimits = {},
): ExecutionHooks {
  const {
    maxAliases = false,
    maxDepth = false,
    maxFields = false,
    maxIntrospectionDepth = false,
  } = limits;
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
    // Runs before validation and before Leaven caches the document (it caches only validated
    // documents), and for cached documents too, so the limits hold whatever the cache contains.
    // The field count goes first: it bounds the quadratic OverlappingFieldsCanBeMerged rule.
    onParsed: async (document: DocumentNode) => {
      if (maxFields !== false) checkFields(document, maxFields);
      if (maxDepth !== false) checkDepth(document, maxDepth);
      if (maxIntrospectionDepth !== false) checkIntrospectionDepth(document, maxIntrospectionDepth);
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

/** Introspection root fields whose selections the depth limit ignores. */
const INTROSPECTION_FIELDS = new Set(['__schema', '__type', '__typename']);
const MAX_DEPTH_VISITS = 100_000;

/**
 * The deepest field selection of any operation, with fragments expanded (each fragment's depth
 * is computed once; a fragment cycle counts as no extra depth, and validation rejects it).
 * Fields named `__schema`, `__type` or `__typename` count as one level, without their
 * selections.
 */
export function queryDepth(document: DocumentNode): number {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition);
  }
  const memo = new Map<string, number>();
  const expanding = new Set<string>();
  let visits = 0;
  const selections = (set: SelectionSetNode | undefined, depth: number): number => {
    let deepest = 0;
    for (const selection of set?.selections ?? []) {
      if (++visits > MAX_DEPTH_VISITS) {
        throw new LeavenError(
          `Query analysis exceeded the maximum of ${MAX_DEPTH_VISITS} nodes`,
          'COMPLEXITY_LIMIT' as ErrorCode,
          { statusCode: 400 },
        );
      }
      if (selection.kind === Kind.FIELD) {
        const nested =
          selection.selectionSet && !INTROSPECTION_FIELDS.has(selection.name.value)
            ? selections(selection.selectionSet, depth + 1)
            : 0;
        deepest = Math.max(deepest, depth, nested);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        deepest = Math.max(deepest, selections(selection.selectionSet, depth));
      } else {
        const relative = fragmentDepth(selection.name.value);
        if (relative > 0) deepest = Math.max(deepest, depth - 1 + relative);
      }
    }
    return deepest;
  };
  // A fragment's depth relative to where it is spread (1 = its own fields).
  const fragmentDepth = (name: string): number => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const fragment = fragments.get(name);
    if (!fragment || expanding.has(name)) return 0;
    expanding.add(name);
    const depth = selections(fragment.selectionSet, 1);
    expanding.delete(name);
    memo.set(name, depth);
    return depth;
  };
  let deepest = 0;
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      deepest = Math.max(deepest, selections(definition.selectionSet, 1));
    }
  }
  return deepest;
}

/**
 * Rejects a document with more than `max` field selections (FIELD_LIMIT): both the field nodes
 * written in all its operations and fragments (spread or not, since validation visits them all)
 * and the fields of every operation with fragments expanded where they are spread (each fragment is counted
 * once and memoized; a cycle adds nothing, and validation rejects it). Stops as soon as the
 * count passes `max`, and visits at most 100 000 selections.
 */
export function checkFields(document: DocumentNode, max: number): void {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition);
  }
  const memo = new Map<string, number>();
  let visits = 0;
  let total = 0;
  const over = () =>
    new LeavenError(`The document selects more than ${max} fields.`, 'FIELD_LIMIT' as ErrorCode, {
      statusCode: 400,
    });
  const count = (set: SelectionSetNode | undefined): number => {
    let n = 0;
    for (const selection of set?.selections ?? []) {
      if (++visits > MAX_DEPTH_VISITS) throw over();
      if (selection.kind === Kind.FIELD) n += 1 + count(selection.selectionSet);
      else if (selection.kind === Kind.INLINE_FRAGMENT) n += count(selection.selectionSet);
      else {
        const name = selection.name.value;
        let known = memo.get(name);
        if (known === undefined) {
          memo.set(name, 0); // a cycle counts as nothing
          known = count(fragments.get(name)?.selectionSet);
          memo.set(name, known);
        }
        n += known;
      }
      if (n > max) throw over();
    }
    return n;
  };
  // Validation walks every definition, spread or not: the field nodes written in the document
  // (operations and fragments, unexpanded) are capped too.
  let written = 0;
  const stack: SelectionSetNode[] = [];
  for (const definition of document.definitions) {
    if (
      definition.kind === Kind.OPERATION_DEFINITION ||
      definition.kind === Kind.FRAGMENT_DEFINITION
    )
      stack.push(definition.selectionSet);
  }
  while (stack.length > 0) {
    for (const selection of stack.pop()!.selections) {
      if (selection.kind === Kind.FIELD && ++written > max) throw over();
      if (selection.kind !== Kind.FRAGMENT_SPREAD && selection.selectionSet)
        stack.push(selection.selectionSet);
    }
  }
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    total += count(definition.selectionSet);
    if (total > max) throw over();
  }
}

/**
 * The deepest selection under an introspection field (`__schema` or `__type`), counting that
 * field as level 1, with fragments expanded (memoized; a cycle adds no depth).
 */
export function introspectionDepth(document: DocumentNode): number {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition);
  }
  const memo = new Map<string, number>();
  const expanding = new Set<string>();
  let visits = 0;
  const visit = () => {
    if (++visits > MAX_DEPTH_VISITS) {
      throw new LeavenError(
        `Query analysis exceeded the maximum of ${MAX_DEPTH_VISITS} nodes`,
        'COMPLEXITY_LIMIT' as ErrorCode,
        { statusCode: 400 },
      );
    }
  };
  // Depth of a selection set relative to its parent field (1 = its own fields).
  const height = (set: SelectionSetNode | undefined): number => {
    let deepest = 0;
    for (const selection of set?.selections ?? []) {
      visit();
      if (selection.kind === Kind.FIELD)
        deepest = Math.max(deepest, 1 + height(selection.selectionSet));
      else if (selection.kind === Kind.INLINE_FRAGMENT)
        deepest = Math.max(deepest, height(selection.selectionSet));
      else deepest = Math.max(deepest, fragmentHeight(selection.name.value));
    }
    return deepest;
  };
  const fragmentHeight = (name: string): number => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const fragment = fragments.get(name);
    if (!fragment || expanding.has(name)) return 0;
    expanding.add(name);
    const h = height(fragment.selectionSet);
    expanding.delete(name);
    memo.set(name, h);
    return h;
  };
  // Find the introspection fields anywhere in the operations (they are usually at the root).
  const seen = new Set<string>();
  const find = (set: SelectionSetNode | undefined): number => {
    let deepest = 0;
    for (const selection of set?.selections ?? []) {
      visit();
      if (selection.kind === Kind.FIELD) {
        const name = selection.name.value;
        if (name === '__schema' || name === '__type') {
          deepest = Math.max(deepest, 1 + height(selection.selectionSet));
        } else deepest = Math.max(deepest, find(selection.selectionSet));
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        deepest = Math.max(deepest, find(selection.selectionSet));
      } else if (!seen.has(selection.name.value)) {
        seen.add(selection.name.value);
        deepest = Math.max(deepest, find(fragments.get(selection.name.value)?.selectionSet));
      }
    }
    return deepest;
  };
  let deepest = 0;
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION)
      deepest = Math.max(deepest, find(definition.selectionSet));
  }
  return deepest;
}

/** Rejects a document deeper than `max` with Leaven's DEPTH_LIMIT error. */
export function checkDepth(document: DocumentNode, max: number): void {
  const depth = queryDepth(document);
  if (depth > max) throw new DepthLimitError(depth, max);
}

/** Rejects introspection selections deeper than `max` (DEPTH_LIMIT). */
export function checkIntrospectionDepth(document: DocumentNode, max: number): void {
  const depth = introspectionDepth(document);
  if (depth > max) {
    throw new LeavenError(
      `Introspection depth of ${depth} exceeds maximum allowed depth of ${max}`,
      'DEPTH_LIMIT' as ErrorCode,
      { statusCode: 400, extensions: { depth, maxIntrospectionDepth: max } },
    );
  }
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

/**
 * Leaven codes client mistakes in the request (a missing or unknown operation name, a variable
 * that does not coerce) BAD_REQUEST; Knead reports client input as BAD_USER_INPUT. Anything
 * non-GraphQL thrown inside Leaven's pipeline (a failing custom cache, a compiler error) is
 * INTERNAL_ERROR with the raw message: it is logged and becomes INTERNAL_SERVER_ERROR, masked
 * when `maskErrors`.
 */
export function normalizeResponse<T>(
  response: GraphQLResponse<T>,
  masking: ErrorMaskingOptions,
): GraphQLResponse<T> {
  const code = (error: { extensions?: { code?: unknown } }) => error.extensions?.code;
  if (!response.errors?.some((e) => code(e) === 'INTERNAL_ERROR' || code(e) === 'BAD_REQUEST')) {
    return response;
  }
  const errors = response.errors.map((error) => {
    if (code(error) === 'BAD_REQUEST') {
      return { ...error, extensions: { ...error.extensions, code: 'BAD_USER_INPUT' } };
    }
    if (code(error) !== 'INTERNAL_ERROR') return error;
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

/** The hooks Leaven runs before it selects and executes the operation. */
const PRE_EXECUTION_HOOKS = ['onParse', 'onParsed', 'onValidate', 'onValidated'] as const;

/** What GraphQLExecutor records about one execute() or subscribe() call. */
interface CallState {
  /** A pre-execution hook threw. */
  rejected: boolean;
  /** Leaven reached onExecute: its pipeline (parse, cache, validation, compile) completed. */
  executing: boolean;
}

/**
 * Wraps the pre-execution hooks so a throw from one (Knead's document limits run in `onParsed`)
 * flags the current call: Leaven reports those throws without marking them as request
 * rejections. `onExecute` (always set, so a call that never reaches it is known) records that
 * Leaven's pipeline completed.
 */
function trackPreExecution(
  hooks: ExecutionHooks | undefined,
  calls: AsyncLocalStorage<CallState>,
): ExecutionHooks {
  const tracked: Record<string, unknown> = { ...hooks };
  for (const name of PRE_EXECUTION_HOOKS) {
    const hook = hooks?.[name] as ((...args: unknown[]) => unknown) | undefined;
    if (!hook) continue;
    tracked[name] = async (...args: unknown[]) => {
      try {
        await hook(...args);
      } catch (error) {
        const call = calls.getStore();
        if (call) call.rejected = true;
        throw error;
      }
    };
  }
  const onExecute = hooks?.onExecute;
  tracked.onExecute = async (context: unknown, document: DocumentNode) => {
    const call = calls.getStore();
    if (call) call.executing = true;
    await onExecute?.(context, document);
  };
  return tracked as ExecutionHooks;
}

/**
 * LeavenExecutor whose request-level errors are normalized (used for HTTP, WebSocket and SSE),
 * and which remembers which of its responses are request errors.
 */
export class GraphQLExecutor extends LeavenExecutor {
  readonly #masking: ErrorMaskingOptions;
  readonly #calls: AsyncLocalStorage<CallState>;
  readonly #rejected = new WeakSet<object>();

  constructor(config: ExecutorConfig, masking: ErrorMaskingOptions) {
    const calls = new AsyncLocalStorage<CallState>();
    super({ ...config, hooks: trackPreExecution(config.hooks, calls) });
    this.#masking = masking;
    this.#calls = calls;
  }

  override async execute<TData = Record<string, unknown>, TContext = unknown>(
    request: GraphQLRequest,
    context?: TContext,
  ): Promise<ExecutionResult<TData>> {
    const call: CallState = { rejected: false, executing: false };
    const result = await this.#calls.run(call, () =>
      super.execute<TData, TContext>(request, context),
    );
    return { ...result, response: this.#normalize(result.response, call) };
  }

  override async subscribe<TData = Record<string, unknown>, TContext = unknown>(
    request: GraphQLRequest,
    context?: TContext,
  ): Promise<SubscriptionIterator<TData> | GraphQLResponse<TData>> {
    const call: CallState = { rejected: false, executing: false };
    const result = await this.#calls.run(call, () =>
      super.subscribe<TData, TContext>(request, context),
    );
    return Symbol.asyncIterator in result ? result : this.#normalize(result, call);
  }

  /**
   * True for a response this executor's `execute` or `subscribe` returned when nothing ran: Leaven
   * rejected the request before execution (`isRequestError` from `@leaven-graphql/sse`: syntax,
   * parser limits, validation, operation selection, complexity, variable coercion) or a
   * pre-execution hook threw (Knead's `maxFields`, `maxAliases`, `maxDepth` and
   * `maxIntrospectionDepth` checks, or the application's `onParse`/`onParsed`/`onValidate`/
   * `onValidated`), or Leaven's pipeline failed before execution (a document cache that throws:
   * INTERNAL_SERVER_ERROR). Identity-based: pass the response object as returned. Classified by where
   * the error arose, never by its code, so an error raised after execution started (a resolver,
   * `onExecute`, `onExecuted`) is never a request error.
   */
  isRequestError(response: GraphQLResponse<unknown>): boolean {
    return this.#rejected.has(response);
  }

  /** Normalizes a response, keeping the request-error mark on the copy normalizeResponse may make. */
  #normalize<TData>(response: GraphQLResponse<TData>, call: CallState): GraphQLResponse<TData> {
    const preExecution = call.rejected || !call.executing;
    const rejected = isRequestError(response) || (preExecution && response.data === undefined);
    const normalized = normalizeResponse(response, this.#masking);
    if (rejected) this.#rejected.add(normalized);
    return normalized;
  }
}

/** Owns the schema, the Leaven executor and the subscription endpoint. */
@Injectable()
export class GraphQLRuntime implements OnModuleInit, OnModuleDestroy {
  /** The application's development flag (HTTP_DEVELOPMENT). */
  readonly development: boolean = inject(HTTP_DEVELOPMENT);
  /** Playground, introspection, masking and emitSchemaFile defaults follow `development`. */
  readonly options: ResolvedGraphQLOptions = resolveOptions(
    inject(GRAPHQL_OPTIONS),
    inject(GRAPHQL_PATH),
    this.development,
  );
  readonly pubsub = inject(PUBSUB);
  readonly logger = inject(LOGGER);
  readonly #modules = inject(MODULES);
  readonly #ws = inject(WsRegistry);
  /** @internal The open SSE subscription streams. */
  readonly sse = new SseConnections();
  #schema: GraphQLSchema | undefined;
  #executor: GraphQLExecutor | undefined;
  #playground: PlaygroundGate | undefined;
  #endpoint: SubscriptionEndpoint | undefined;
  readonly #fieldGuards = new Map<Class, FieldGuardSet | undefined>();

  get schema(): GraphQLSchema {
    if (!this.#schema)
      throw new SchemaBuildError('The GraphQL schema is built during onModuleInit.');
    return this.#schema;
  }

  get executor(): GraphQLExecutor {
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
      mapError: this.options.mapError,
    };
  }

  /** @internal The registry SSE streams take their connection slots from (shared with WebSocket). */
  get ws(): WsRegistry {
    return this.#ws;
  }

  /** `listen({ websocket: { maxPendingRevocations } })`, also the per-socket deferral cap. */
  get maxPendingRevocations(): number {
    return this.#ws.maxPendingRevocations;
  }

  /** The GraphQL connection of a subscription socket, or undefined for any other socket. */
  connection(ws: WsSocket): GraphQLConnection | undefined {
    return this.#endpoint?.connection(ws);
  }

  /** @internal See SubscriptionEndpoint.deferRevocation. */
  deferRevocation(
    ws: WsSocket,
    predicate: (connection: GraphQLConnection) => boolean,
    code: number,
    reason: string,
  ): boolean {
    return this.#endpoint?.deferRevocation(ws, predicate, code, reason) ?? false;
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
        hooks: buildHooks(hooks, this.masking, {
          maxAliases: this.options.maxAliases,
          maxDepth: this.options.maxDepth,
          maxFields: this.options.maxFields,
          maxIntrospectionDepth: this.options.maxIntrospectionDepth,
        }),
        formatExecutionError: createErrorFormatter(this.masking),
      },
      this.masking,
    );
    (this.pubsub as { useLogger?: (logger: unknown, development?: boolean) => void }).useLogger?.(
      this.logger,
      this.development,
    );
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
    const sse = this.options.sse;
    if (sse !== false) {
      // Checked at listen(): Bun closes a stream quiet for longer than its idleTimeout.
      this.#ws.requireKeepAliveBelowIdle(
        'GraphQL SSE (subscriptions.sse.keepAliveInterval)',
        sse.keepAliveInterval,
      );
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
    for (const ref of this.options.guards) assertGuardRef(ref, 'GraphQLModule guards');
    for (const resolver of discoverResolvers(this.#modules)) {
      const target = getMetadata(resolver.cls, RESOLVER)?.type?.();
      // The target is built even when no field returns it, whatever the resolver's methods are.
      if (target && !types.includes(target)) types.push(target);
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
          // graphql-js resolves an interface's fields on the concrete object type, so a resolver
          // (and its guards) on an interface would never run: refuse it rather than serve raw values.
          const kind = getOwnMetadata(target, TYPE_DEF)?.kind;
          if (kind !== undefined && kind !== 'object') {
            throw new SchemaBuildError(
              `${spec.owner}: @ResolveField on @${KIND_DECORATOR[kind]} ${target.name} is not ` +
                'supported; resolve it on each concrete type.',
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
        }
      }
    }
    return new SchemaBuilder({
      query,
      mutation,
      subscription,
      typeFields,
      types,
      fieldGuards: (cls) => this.#fieldGuardsOf(cls),
      wrapField: (cls, resolve) =>
        guardField(this.#fieldGuardsOf(cls)!, this.#rootInjector(), resolve),
    }).build();
  }

  /** The root module's injector: it sees the root's own providers, its imports' exports and globals. */
  #rootInjector(): ModuleInjector {
    // MODULES is in initialization order (imports before importers), so the root comes last.
    const root = this.#modules.at(-1);
    if (!root) throw new SchemaBuildError('GraphQLRuntime: no modules to resolve field guards in.');
    return root.injector;
  }

  /** `@UseFieldGuards` of `cls` (ROUTE_META[FIELD_GUARDS]), checked and resolved once per class. */
  #fieldGuardsOf(cls: Class): FieldGuardSet | undefined {
    if (this.#fieldGuards.has(cls)) return this.#fieldGuards.get(cls);
    const meta = Object.freeze({ ...(getMetadata(cls, ROUTE_META) ?? {}) });
    const refs = meta[FIELD_GUARDS];
    let set: FieldGuardSet | undefined;
    if (refs !== undefined) {
      const where = `the field guards of ${cls.name}`;
      if (!Array.isArray(refs)) {
        throw new SchemaBuildError(`Invalid ${where}: ROUTE_META[FIELD_GUARDS] is not an array.`);
      }
      for (const ref of refs) assertGuardRef(ref, where);
      if (refs.length > 0) {
        const injector = this.#rootInjector();
        set = { guards: refs.map((ref) => resolveGuard(ref, injector)), meta };
      }
    }
    this.#fieldGuards.set(cls, set);
    return set;
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
    for (const ref of own) assertGuardRef(ref, `the guards of ${owner}`);
    const authorizeRefs = options.authorize ?? [];
    for (const ref of authorizeRefs) assertGuardRef(ref, `the authorize guards of ${owner}`);
    // Module guards and defaultDeny apply to root fields (not @ResolveField) unless @Public().
    const root = def.kind !== 'field' && meta[IS_PUBLIC] !== true;
    // The field's own guards and authorize guards satisfy defaultDeny; module guards do not.
    const denied =
      root && this.options.defaultDeny && own.length === 0 && authorizeRefs.length === 0;
    const guards = [...(denied ? [DENY] : []), ...(root ? this.options.guards : []), ...own].map(
      (ref) => resolveGuard(ref, injector),
    );
    const authorize = authorizeRefs.map((ref) => resolveGuard(ref, injector));
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
      // Authorization that depends on the validated (canonical) arguments.
      if (guarded) await runGuards(authorize, ctx);
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
    // The arguments validated at subscribe time, reused for every event of that subscription
    // (graphql-js passes each event the same contextValue; a subscription has one root field).
    const validated = new WeakMap<OperationContext, unknown>();
    // Each event starts with fresh state and DataLoaders, reset by its first stage (the filter,
    // then the guard recheck, then the resolver), so no stage sees what subscribe time or the
    // previous event cached, and the later stages of an event see what the earlier ones set.
    const resetIn = sub.filter ? 'filter' : sub.recheckGuards ? 'recheck' : 'resolve';
    spec.subscribe = marked(async (parent, args, op: OperationContext, info) => {
      const ctx = await prepare(parent, args, op, info, true);
      validated.set(op, ctx.args);
      const computed = typeof sub.topic === 'function' ? sub.topic(ctx) : sub.topic;
      const topics = [...new Set(typeof computed === 'string' ? [computed] : computed)];
      if (typeof sub.topic === 'function') {
        // A computed topic usually embeds client input: bound how many the client can open, and
        // reject wildcards, which would let it listen to other topics on engines with patterns.
        if (topics.length > MAX_SUBSCRIPTION_TOPICS) {
          throw new BadRequestException(
            `A subscription cannot listen to more than ${MAX_SUBSCRIPTION_TOPICS} topics.`,
          );
        }
        rejectWildcards(topics);
      }
      const filter = sub.filter;
      let warned = false;
      // A throwing filter lets its event through as this error, delivered (formatted, so a client
      // HttpException keeps its code) in place of the event, which then ends the subscription.
      let filterError: unknown;
      const events = eventIterator(
        this.pubsub,
        topics,
        filter
          ? async (payload) => {
              op.resetForEvent();
              try {
                // Built per event from op.user, so the filter sees a refreshContext identity.
                const current = createResolverCtx(op, injector, meta, ctx.args, parent, info);
                return await filter({ payload, args: ctx.args, ctx: current });
              } catch (error) {
                filterError = toSafeError(error, this.masking, `${owner} filter`);
                return true;
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
      if (!filter && !sub.recheckGuards) return events;
      const subscriptions = this.options.subscriptions;
      const refresh = subscriptions === false ? undefined : subscriptions.refreshContext;
      return checkEvents(events, async () => {
        if (filterError !== undefined) throw filterError;
        if (!sub.recheckGuards) return;
        if (resetIn === 'recheck') op.resetForEvent();
        if (refresh) {
          let refreshed: unknown;
          try {
            refreshed = await refresh({ http: op.http, context: op.user });
          } catch (error) {
            throw toSafeError(error, this.masking, 'subscriptions.refreshContext');
          }
          // Fail closed: only an object keeps the subscription alive (false, undefined, null,
          // true or anything else ends it).
          if (typeof refreshed !== 'object' || refreshed === null) throw new ForbiddenException();
          op.user = { ...op.user, ...refreshed };
        }
        // ctx.args are the validated arguments from subscribe time, as authorize expects.
        const recheck = createResolverCtx(op, injector, meta, ctx.args, parent, info);
        await runGuards(guards, recheck);
        await runGuards(authorize, recheck);
      });
    });
    spec.resolve = marked(async (payload, _args, op: OperationContext, info) => {
      if (payload instanceof RevokedEvent) throw payload.error;
      // Without a subscribe call for this operation (a subscription document executed as a
      // query or mutation would be), no guard has run: refuse rather than call the method.
      if (!validated.has(op)) {
        throw new BadRequestException('Subscriptions are only available over WebSocket.');
      }
      if (resetIn === 'resolve') op.resetForEvent();
      const value = sub.resolve ? await sub.resolve(payload) : payload;
      const ctx = createResolverCtx(op, injector, meta, validated.get(op), value, info);
      const result = await call(ctx);
      return result === undefined ? value : result;
    });
    return spec;
  }
}
