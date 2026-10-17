import { AbilityBuilder, createMongoAbility, type MongoAbility } from '@casl/ability';
import { inject } from '@knead-js/core';
import { ForbiddenException, UnauthorizedException } from '@knead-js/http';
import { type AppAbility, createAppAbility, grantRules, intersectRules } from './ability.js';
import { type Grant, parseGrant } from './grant.js';
import { type AbilityCtx, CASL_OPTIONS } from './options.js';

const ABILITY = Symbol('knead:casl:ability');

type Cached = Promise<AppAbility | null>;

/**
 * Bound to the state object it was stored on: a spread copy of that state (a WebSocket
 * operation's copy of its upgrade request's state) carries the entry but must not use it.
 */
interface CacheEntry {
  owner: object;
  promise: Cached;
}

export type GrantProblem =
  | { reason: 'malformed' }
  | {
      reason: 'exceeds-user';
      area: string;
      level: string;
      action: string;
      subject: string;
      /** Set when the grant's rule names fields and the user may not use this one. */
      field?: string;
    };

export type GrantValidation = { ok: true; grant: Grant } | { ok: false; problems: GrantProblem[] };

/** The ability promise cached on `ctx.state` by AbilityService.forCtx(), if any (internal). */
export function cachedAbility(ctx: AbilityCtx): Cached | undefined {
  const entry = ctx.state[ABILITY] as CacheEntry | undefined;
  return entry?.owner === ctx.state ? entry.promise : undefined;
}

/** A GraphQL subscription root field runs per event; its ability must never be cached. */
function isSubscriptionRoot(ctx: AbilityCtx): boolean {
  if (!('info' in ctx)) return false;
  const { info } = ctx;
  return info.parentType.name === info.schema.getSubscriptionType()?.name;
}

export class AbilityService {
  readonly #options = inject(CASL_OPTIONS);

  /** Cached ability for this request/operation; UnauthorizedException when resolve() gives none. */
  async forCtx(ctx: AbilityCtx): Promise<AppAbility> {
    const ability = await this.#cached(ctx);
    if (!ability) throw new UnauthorizedException();
    return ability;
  }

  /** ForbiddenException unless allowed. `subject` is a type name or a record tagged with asSubject. */
  async authorize(
    ctx: AbilityCtx,
    action: string,
    subject: string | object,
    field?: string,
  ): Promise<void> {
    const ability = await this.forCtx(ctx);
    if (ability.can(action, subject, field) !== true) throw new ForbiddenException();
  }

  /**
   * Checks that every rule a requested grant would allow is something `user` can do, at least
   * conditionally: each action/subject pair, and each field when the grant's rule names fields.
   */
  async validateGrant(user: unknown, input: unknown): Promise<GrantValidation> {
    const { permissions } = this.#options;
    const grant = parseGrant(input, permissions);
    if (!grant) return { ok: false, problems: [{ reason: 'malformed' }] };
    const ability = createAppAbility(await this.#userRules(user));
    const problems: GrantProblem[] = [];
    const seen = new Set<string>();
    for (const area of Object.keys(grant)) {
      const level = grant[area]!;
      for (const rule of permissions.rulesFor(area, level)) {
        const fields: (string | undefined)[] = rule.fields ? [rule.fields].flat() : [undefined];
        for (const action of [rule.action].flat() as string[]) {
          for (const subject of [rule.subject ?? 'all'].flat() as string[]) {
            for (const field of fields) {
              const key = JSON.stringify([area, action, subject, field ?? null]);
              if (seen.has(key)) continue;
              seen.add(key);
              // A field must be allowed (a `cannot` on it wins). A pair needs a positive rule
              // that no higher-priority unconditional `cannot` (no conditions, no fields) shadows.
              const allowed =
                field === undefined
                  ? ability
                      .possibleRulesFor(action, subject)
                      .find((r) => !r.inverted || (!r.conditions && !r.fields))?.inverted === false
                  : ability.can(action, subject, field) === true;
              if (allowed) continue;
              problems.push({
                reason: 'exceeds-user',
                area,
                level,
                action,
                subject,
                ...(field !== undefined && { field }),
              });
            }
          }
        }
      }
    }
    return problems.length === 0 ? { ok: true, grant } : { ok: false, problems };
  }

  #cached(ctx: AbilityCtx): Cached {
    if (isSubscriptionRoot(ctx)) return this.#build(ctx);
    const existing = cachedAbility(ctx);
    if (existing) return existing;
    const { state } = ctx;
    const entry: CacheEntry = { owner: state, promise: this.#build(ctx) };
    state[ABILITY] = entry;
    entry.promise.catch(() => {
      if (state[ABILITY] === entry) delete state[ABILITY];
    });
    return entry.promise;
  }

  async #build(ctx: AbilityCtx): Cached {
    const identity = await this.#options.resolve(ctx);
    if (identity == null) return null;
    // Parse first: a malformed or missing grant denies everything, so skip defineUserAbility.
    const grant = parseGrant(identity.grant, this.#options.permissions);
    if (!grant) return createAppAbility([]);
    const userRules = await this.#userRules(identity.user);
    return createAppAbility(
      intersectRules(userRules, grantRules(grant, this.#options.permissions)),
    );
  }

  async #userRules(user: unknown) {
    const builder = new AbilityBuilder<MongoAbility>(createMongoAbility);
    await this.#options.defineUserAbility(user, builder);
    return builder.rules;
  }
}
