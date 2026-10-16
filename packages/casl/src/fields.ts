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

/** Fails closed: every non-opaque object is stripped, whatever its prototype. */
function strip(ability: AppAbility, subjectType: string, value: unknown, toJson = true): unknown {
  if (isOpaque(value)) return value;
  if (Array.isArray(value)) return value.map((item) => strip(ability, subjectType, item));
  const record = value as object;
  const { toJSON } = record as { toJSON?: unknown };
  if (toJson && typeof toJSON === 'function') {
    return strip(ability, subjectType, toJSON.call(record), false);
  }
  return pickPermitted(ability, subjectType, record);
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
      return strip(ability, subjectType, await method.call(this, ctx));
    };
    return wrapped as unknown as T;
  };
}
