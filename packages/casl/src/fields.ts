import type { Ctx } from '@knead-js/http';
import { ForbiddenException } from '@knead-js/http';
import { type AppAbility, asSubject } from './ability.js';
import type { AbilityCtx } from './options.js';
import { cachedAbility } from './service.js';

/** Keeps the own enumerable string keys of `record` that `ability` lets the caller `read`. */
export function pickPermitted<T extends object>(
  ability: AppAbility,
  subjectType: string,
  record: T,
): Partial<T> {
  const subject = asSubject(subjectType, record);
  const out: Partial<T> = {};
  for (const key of Object.keys(record)) {
    if (ability.can('read', subject, key) === true) {
      Object.defineProperty(out, key, {
        value: (record as Record<string, unknown>)[key],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return out;
}

function isOpaque(value: unknown): boolean {
  return (
    typeof value !== 'object' ||
    value === null ||
    value instanceof Response ||
    value instanceof Blob ||
    value instanceof ReadableStream ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Date
  );
}

/**
 * Fails closed: every non-opaque object is stripped, whatever its prototype. `ancestors` holds the
 * arrays and `toJSON()` records being walked, so a cyclic result (an array containing itself, a
 * `toJSON()` returning its own record) throws instead of overflowing the stack.
 */
function strip(
  ability: AppAbility,
  subjectType: string,
  value: unknown,
  ancestors: WeakSet<object>,
  toJson = true,
): unknown {
  if (isOpaque(value)) return value;
  const record = value as object;
  if (ancestors.has(record)) throw new Error('PermittedFields: the result contains a cycle');
  const { toJSON } = record as { toJSON?: unknown };
  const isArray = Array.isArray(record);
  if (!isArray && !(toJson && typeof toJSON === 'function')) {
    return pickPermitted(ability, subjectType, record);
  }
  ancestors.add(record);
  try {
    if (isArray) return record.map((item) => strip(ability, subjectType, item, ancestors));
    const json = (toJSON as () => unknown).call(record);
    // `toJSON() { return this; }` serializes the record itself: not a cycle.
    if (json === record) return pickPermitted(ability, subjectType, record);
    return strip(ability, subjectType, json, ancestors, false);
  } finally {
    ancestors.delete(record);
  }
}

/**
 * Method decorator: filters the handler's result to fields `read`-permitted on `subjectType`.
 *
 * The result itself (or each array element, recursively) is stripped; objects with `toJSON` are
 * stripped after it runs. Envelopes such as `{ data: [...], total }` are only stripped at the top
 * level, so handlers should return the records or the array directly.
 */
export function PermittedFields(subjectType: string) {
  return <T extends (this: any, ctx: Ctx<any>) => unknown>(
    method: T,
    _context: ClassMethodDecoratorContext,
  ): T => {
    const wrapped = async function (this: unknown, ctx: Ctx<any>) {
      const pending = cachedAbility(ctx as AbilityCtx);
      const ability = pending ? await pending : null;
      if (!ability) throw new ForbiddenException('PermittedFields requires AbilityGuard');
      return strip(ability, subjectType, await method.call(this, ctx), new WeakSet());
    };
    return wrapped as unknown as T;
  };
}
