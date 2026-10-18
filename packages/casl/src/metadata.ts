import { type ClassOrMethodDecorator, createRouteDecorator } from '@knead-js/http';

/** Route-meta key holding the route's CanRequirement. */
export const CAN = Symbol.for('knead:casl:can');
/**
 * Route-meta key; `true` makes AbilityGuard pass without checking. `@Can()` sets it to `false`, so
 * a method's `@Can()` overrides its controller's `@SkipAbility()`.
 */
export const SKIP = Symbol.for('knead:casl:skip');

export interface CanRequirement {
  action: string;
  subject: string;
  field?: string;
}

const setCan = createRouteDecorator<CanRequirement>(CAN);
const setSkip = createRouteDecorator<boolean>(SKIP);

type DecoratorContext = Parameters<ClassOrMethodDecorator>[1];
const CLASS_LEVEL = Symbol('class');
/** The levels (class, or a method name) of each class's metadata that `@SkipAbility()` decorates. */
const skippedLevels = new WeakMap<DecoratorMetadataObject, Set<PropertyKey>>();
const level = (context: DecoratorContext): PropertyKey =>
  context.kind === 'class' ? CLASS_LEVEL : context.name;

function requirement(action: string, subject: string, field?: string): CanRequirement {
  return field === undefined ? { action, subject } : { action, subject, field };
}

/** Requires `ability.can(action, subject, field)` (checked by AbilityGuard). */
export function Can(action: string, subject: string, field?: string): ClassOrMethodDecorator {
  const can = setCan(requirement(action, subject, field));
  return (target, context) => {
    can(target, context);
    // The more specific level wins: a method's @Can() clears its controller's @SkipAbility()
    // (route meta merges method over class). On the same level, @SkipAbility() still wins.
    if (!skippedLevels.get(context.metadata)?.has(level(context))) setSkip(false)(target, context);
  };
}

/**
 * `@Can()` as plain meta, for places without a decorator, such as a WebSocket endpoint:
 * `ws.register('/feed', endpoint, { meta: canMeta('read', 'Post') })`.
 */
export function canMeta(
  action: string,
  subject: string,
  field?: string,
): Readonly<Record<PropertyKey, unknown>> {
  return { [CAN]: requirement(action, subject, field) };
}

/** `@SkipAbility()` as plain meta: `ws.register('/public', endpoint, { meta: skipAbilityMeta() })`. */
export function skipAbilityMeta(): Readonly<Record<PropertyKey, unknown>> {
  return { [SKIP]: true };
}

/**
 * `@Can` typed to your app's action and subject names; same route meta as `Can`:
 * `export const Can = createCan<AppActions, AppSubjects>();`
 */
export function createCan<Actions extends string, Subjects extends string>(): (
  action: Actions,
  subject: Subjects,
  field?: string,
) => ClassOrMethodDecorator {
  return Can;
}

/** Makes AbilityGuard pass without resolving an identity (public routes). */
export function SkipAbility(): ClassOrMethodDecorator {
  const skip = setSkip(true);
  return (target, context) => {
    skip(target, context);
    const levels = skippedLevels.get(context.metadata) ?? new Set();
    levels.add(level(context));
    skippedLevels.set(context.metadata, levels);
  };
}
