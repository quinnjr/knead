import { inject, readMetadata, setMetadata } from '@knead-js/core';
import { type Guard, ROUTE_META } from '@knead-js/http';
import { asSubject } from './ability.js';
import type { GraphQLLikeCtx } from './options.js';
import { AbilityService } from './service.js';

/** Route-meta key holding an `@AbilitySubject` type's CASL subject type. */
export const SUBJECT = Symbol.for('knead:casl:subject');

/** `@knead-js/graphql`'s FIELD_GUARDS key; shared by `Symbol.for`, so no runtime import. */
const FIELD_GUARDS = Symbol.for('knead:gql:field-guards');

/** The parts of a GraphQL field resolver ctx FieldAbilityGuard reads. */
interface FieldCtx extends GraphQLLikeCtx {
  parent: unknown;
}

/**
 * Field guard added by `@AbilitySubject`: passes only when the caller may `read` the field
 * (by its GraphQL name) on the parent record, tagged as the type's subject.
 */
export class FieldAbilityGuard implements Guard<any> {
  readonly #abilities = inject(AbilityService);

  async canActivate(ctx: FieldCtx): Promise<boolean> {
    const subjectType = ctx.meta[SUBJECT];
    const { parent } = ctx;
    if (typeof subjectType !== 'string' || typeof parent !== 'object' || parent === null) {
      return false;
    }
    const ability = await this.#abilities.forCtx(ctx);
    return ability.can('read', asSubject(subjectType, parent), ctx.info.fieldName) === true;
  }
}

/**
 * For `@ObjectType` classes: every field (plain `@Field` and `@ResolveField`) requires `read` on
 * `subjectType` for the parent record and that field, by its GraphQL name. Put it on each
 * concrete `@ObjectType`: `@InterfaceType` classes are not wrapped. Combines with
 * `@UseFieldGuards` and is inherited by subclasses (a subclass's own `@AbilitySubject` replaces
 * the subject type).
 */
export function AbilitySubject(
  subjectType: string,
): (target: Function, context: ClassDecoratorContext) => void {
  return (_target, context) => {
    // May be the parent class's object: copy it, never mutate it.
    const current = readMetadata(context.metadata, ROUTE_META) ?? {};
    const existing = (current[FIELD_GUARDS] as readonly unknown[] | undefined) ?? [];
    // An inherited FieldAbilityGuard already reads the (replaced) SUBJECT: add it only once.
    const guards = existing.includes(FieldAbilityGuard)
      ? existing
      : [...existing, FieldAbilityGuard];
    setMetadata(context.metadata, ROUTE_META, {
      ...current,
      [SUBJECT]: subjectType,
      [FIELD_GUARDS]: Object.freeze([...guards]),
    });
  };
}
