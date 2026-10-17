import { type ModuleInjector, readMetadata, setMetadata } from '@knead-js/core';
import { ForbiddenException, type Guard, type GuardRef, ROUTE_META } from '@knead-js/http';
import type { GraphQLFieldResolver } from 'graphql';
import { createResolverCtx, type OperationContext, type ResolverCtx } from './context.js';
import { markResolverError } from './errors.js';

/** Route-meta key holding a type's field guard list. Symbol.for so @knead-js/casl can write it without importing this package. */
export const FIELD_GUARDS = Symbol.for('knead:gql:field-guards');

/** Class decorator for @ObjectType classes: guards run before every field of the type (plain @Field and @ResolveField). Appends to any list already in the type's ROUTE_META[FIELD_GUARDS]; inherited by subclasses. */
export function UseFieldGuards(
  ...guards: GuardRef<ResolverCtx<{}, any>>[]
): (target: Function, context: ClassDecoratorContext) => void {
  return (_target, context) => {
    // May be the parent class's object: copy it, never mutate it.
    const current = readMetadata(context.metadata, ROUTE_META) ?? {};
    const existing = (current[FIELD_GUARDS] as readonly GuardRef<any>[] | undefined) ?? [];
    setMetadata(context.metadata, ROUTE_META, {
      ...current,
      [FIELD_GUARDS]: Object.freeze([...existing, ...guards]),
    });
  };
}

/** The resolved field guards of an object type and the type's route meta (ctx.meta). */
export interface FieldGuardSet {
  readonly guards: readonly Guard<any>[];
  readonly meta: Readonly<Record<PropertyKey, unknown>>;
}

/**
 * @internal Wraps a field resolver so `guards` run first. Only `=== true` passes; while every
 * guard answers a synchronous `true` the call stays synchronous (no promise, no microtask).
 */
export function guardField(
  { guards, meta }: FieldGuardSet,
  injector: ModuleInjector,
  resolve: GraphQLFieldResolver<any, any>,
): GraphQLFieldResolver<any, OperationContext> {
  const rest = async (
    pending: unknown,
    from: number,
    ctx: ResolverCtx<any, any>,
    run: () => unknown,
  ): Promise<unknown> => {
    try {
      if ((await pending) !== true) throw new ForbiddenException();
      for (let i = from; i < guards.length; i++) {
        if ((await guards[i]!.canActivate(ctx)) !== true) throw new ForbiddenException();
      }
    } catch (error) {
      throw markResolverError(error);
    }
    return run();
  };
  return (parent, args, op, info) => {
    const ctx = createResolverCtx(op, injector, meta, args, parent, info);
    const run = () => resolve(parent, args, op, info);
    for (let i = 0; i < guards.length; i++) {
      let verdict: unknown;
      try {
        verdict = guards[i]!.canActivate(ctx);
      } catch (error) {
        throw markResolverError(error);
      }
      if (verdict === true) continue;
      // Awaited like runGuards does, so a thenable that resolves to true passes there and here.
      if (typeof (verdict as PromiseLike<unknown> | null)?.then === 'function') {
        return rest(verdict, i + 1, ctx, run);
      }
      throw markResolverError(new ForbiddenException());
    }
    return run();
  };
}
