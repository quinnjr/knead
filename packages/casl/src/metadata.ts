import { type ClassOrMethodDecorator, createRouteDecorator } from '@knead-js/http';

/** Route-meta key holding the route's CanRequirement. */
export const CAN = Symbol.for('knead:casl:can');
/** Route-meta key; `true` makes AbilityGuard pass without checking. */
export const SKIP = Symbol.for('knead:casl:skip');

export interface CanRequirement {
  action: string;
  subject: string;
  field?: string;
}

const setCan = createRouteDecorator<CanRequirement>(CAN);
const setSkip = createRouteDecorator<true>(SKIP);

/** Requires `ability.can(action, subject, field)` (checked by AbilityGuard). */
export function Can(action: string, subject: string, field?: string): ClassOrMethodDecorator {
  return setCan(field === undefined ? { action, subject } : { action, subject, field });
}

/** Makes AbilityGuard pass without resolving an identity (public routes). */
export function SkipAbility(): ClassOrMethodDecorator {
  return setSkip(true);
}
