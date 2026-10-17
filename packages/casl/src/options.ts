import type { AbilityBuilder, MongoAbility } from '@casl/ability';
import { InjectionToken } from '@knead-js/core';
import type { Ctx } from '@knead-js/http';
import { CaslConfigError } from './errors.js';
import type { Permissions } from './permissions.js';

export interface Identity<U = unknown> {
  user: U;
  /** Raw PAT scopes / JWT claim; parsed with parseGrant. Missing or malformed grants allow nothing. */
  grant: unknown;
}

/**
 * The structural subset of a `@knead-js/graphql` ResolverCtx that this package reads. Declared
 * here so the published types do not depend on the optional graphql peers.
 */
export interface GraphQLLikeCtx {
  state: Record<PropertyKey, unknown>;
  meta: Readonly<Record<PropertyKey, unknown>>;
  info: {
    fieldName: string;
    parentType: { name: string };
    schema: { getSubscriptionType(): { name: string } | null | undefined };
  };
}

/** A REST `Ctx` or a GraphQL resolver ctx. */
export type AbilityCtx = Ctx | GraphQLLikeCtx;

export interface CaslModuleOptions<U = any> {
  permissions: Permissions;
  /** Who is calling and with which grant; `undefined` or `null` means unauthenticated (401). */
  resolve(
    ctx: AbilityCtx,
  ): Identity<U> | null | undefined | Promise<Identity<U> | null | undefined>;
  /** The user's own abilities, before they are narrowed to the credential's grant. */
  defineUserAbility(user: U, builder: AbilityBuilder<MongoAbility>): void | Promise<void>;
}

export const CASL_OPTIONS = new InjectionToken<CaslModuleOptions>('CASL_OPTIONS');

export function validateCaslOptions(options: unknown): asserts options is CaslModuleOptions {
  if (typeof options !== 'object' || options === null) {
    throw new CaslConfigError('CaslModule.forRoot() options must be an object');
  }
  const o = options as Record<string, unknown>;
  const p = o.permissions as Partial<Permissions> | undefined;
  if (
    typeof p !== 'object' ||
    p === null ||
    typeof p.areas !== 'object' ||
    p.areas === null ||
    typeof p.rulesFor !== 'function'
  ) {
    throw new CaslConfigError(
      'CaslModule.forRoot(): permissions must come from definePermissions()',
    );
  }
  for (const fn of ['resolve', 'defineUserAbility'] as const) {
    if (typeof o[fn] !== 'function') {
      throw new CaslConfigError(`CaslModule.forRoot(): ${fn} must be a function`);
    }
  }
}
