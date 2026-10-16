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
  type Ctx,
  ForbiddenException,
  GUARDS,
  type Guard,
  type GuardRef,
  LOGGER,
  ROUTE_META,
  WsRegistry,
} from '@hpmws/http';
import { type CompilerOptions, LeavenExecutor } from '@leaven-graphql/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type GraphQLFieldResolver,
  type GraphQLSchema,
  isInterfaceType,
  isObjectType,
} from 'graphql';
import { createResolverCtx, OperationContext, type ResolverCtx } from './context.js';
import {
  ArgsValidationError,
  type ArgsValidationIssue,
  createErrorFormatter,
  SchemaBuildError,
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
import { eventIterator, PUBSUB } from './pubsub.js';
import { argNames, type FieldSpec, printSortedSchema, SchemaBuilder } from './schema.js';
import { createSubscriptionEndpoint } from './subscriptions.js';
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

async function runGuards(guards: readonly Guard<any>[], ctx: ResolverCtx<any, any>): Promise<void> {
  for (const guard of guards) {
    if (!(await guard.canActivate(ctx))) throw new ForbiddenException();
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

/** Owns the schema, the Leaven executor and the subscription endpoint. */
export class GraphQLRuntime implements OnModuleInit, OnModuleDestroy {
  readonly options: ResolvedGraphQLOptions = resolveOptions(
    inject(GRAPHQL_OPTIONS),
    inject(GRAPHQL_PATH),
  );
  readonly pubsub = inject(PUBSUB);
  readonly logger = inject(LOGGER);
  readonly #modules = inject(MODULES);
  readonly #ws = inject(WsRegistry);
  #schema: GraphQLSchema | undefined;
  #executor: LeavenExecutor | undefined;

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

  get subscriptionsEnabled(): boolean {
    return this.options.subscriptions !== false && this.schema.getSubscriptionType() !== undefined;
  }

  async onModuleInit(): Promise<void> {
    this.#schema = this.#build();
    const calculator = complexityCalculator(this.#schema);
    const { compilerOptions, ...executor } = this.options.executor;
    this.#executor = new LeavenExecutor({
      ...executor,
      schema: this.#schema,
      introspection: this.options.introspection,
      compilerOptions:
        compilerOptions ?? (calculator ? { complexityCalculator: calculator } : undefined),
      formatExecutionError: createErrorFormatter({
        maskErrors: this.options.maskErrors,
        logger: this.logger,
      }),
    });
    if (this.options.emitSchemaFile !== false) {
      await Bun.write(this.options.emitSchemaFile, printSortedSchema(this.#schema));
    }
    const subscriptions = this.options.subscriptions;
    if (subscriptions !== false && this.#schema.getSubscriptionType()) {
      this.#ws.register(this.options.path, createSubscriptionEndpoint(this, subscriptions));
    }
  }

  async onModuleDestroy(): Promise<void> {
    const close = (this.pubsub as { close?: () => unknown }).close;
    if (typeof close === 'function') await close.call(this.pubsub);
  }

  /** One context per operation: the user `context` factory result plus `extra` (onConnect). */
  async createOperationContext(http: Ctx, extra?: object): Promise<OperationContext> {
    const user = this.options.context ? await this.options.context(http) : {};
    return new OperationContext(http, { ...user, ...extra });
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
    const guards = [
      ...(getMetadata(cls, GUARDS) ?? []),
      ...(options.guards ?? []),
      ...(getMethodMetadata(cls, def.method, GUARDS) ?? []),
    ].map((ref) => resolveGuard(ref, injector));
    const meta = Object.freeze({
      ...(getMetadata(cls, ROUTE_META) ?? {}),
      ...(options.meta ?? {}),
      ...(getMethodMetadata(cls, def.method, ROUTE_META) ?? {}),
    });
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
    if (def.kind !== 'subscription') {
      spec.resolve = async (parent, args, op, info) =>
        call(await prepare(parent, args, op, info, true));
      return spec;
    }
    const sub = options as SubscriptionMethodOptions;
    spec.subscribe = async (parent, args, op: OperationContext, info) => {
      const ctx = await prepare(parent, args, op, info, true);
      const topics = typeof sub.topic === 'function' ? sub.topic(ctx) : sub.topic;
      const filter = sub.filter;
      return eventIterator(
        this.pubsub,
        typeof topics === 'string' ? [topics] : [...topics],
        filter ? (payload) => filter({ payload, args: ctx.args, ctx }) : undefined,
      );
    };
    spec.resolve = async (payload, args, op: OperationContext, info) => {
      const value = sub.resolve ? await sub.resolve(payload) : payload;
      const result = await call(await prepare(value, args, op, info, false));
      return result === undefined ? value : result;
    };
    return spec;
  }
}
