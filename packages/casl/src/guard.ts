import { inject } from '@knead-js/core';
import type { Guard } from '@knead-js/http';
import { CAN, type CanRequirement, SKIP } from './metadata.js';
import type { AbilityCtx } from './options.js';
import { AbilityService } from './service.js';

/** `@knead-js/graphql`'s GRAPHQL_ENDPOINT route-meta key (read without importing the package). */
const GRAPHQL_ENDPOINT = Symbol.for('knead:gql:endpoint');

/**
 * True on the GraphQL endpoint's HTTP routes when the GraphQL module itself runs an AbilityGuard
 * (or subclass) on every root field: authorization then happens per resolver, against `@Can()`.
 */
function graphqlDefersToAbilityGuard(ctx: AbilityCtx): boolean {
  if ('info' in ctx) return false;
  const endpoint = ctx.meta[GRAPHQL_ENDPOINT];
  if (typeof endpoint !== 'function') return false;
  const guards: unknown = endpoint();
  return (
    Array.isArray(guards) &&
    guards.some(
      (g) =>
        g === AbilityGuard ||
        g instanceof AbilityGuard ||
        (typeof g === 'function' && g.prototype instanceof AbilityGuard),
    )
  );
}

/**
 * Passes `@SkipAbility()` routes; otherwise requires the route's `@Can()` against the caller's
 * ability. A route without `@Can()` is denied (fail closed). As an app-wide guard it also passes
 * the GraphQL endpoint (queries, mutations and subscription upgrades) when `GraphQLModule` runs
 * `AbilityGuard` in its `guards`, since every root field is then checked; without that, the
 * endpoint is denied like any other route without `@Can()`.
 */
export class AbilityGuard implements Guard<AbilityCtx> {
  readonly #abilities = inject(AbilityService);

  async canActivate(ctx: AbilityCtx): Promise<boolean> {
    if (ctx.meta[SKIP] === true) return true;
    if (graphqlDefersToAbilityGuard(ctx)) return true;
    const required = ctx.meta[CAN] as CanRequirement | undefined;
    if (!required) return false;
    const ability = await this.#abilities.forCtx(ctx);
    return ability.can(required.action, required.subject, required.field) === true;
  }
}
