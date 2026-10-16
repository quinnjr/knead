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
      (out as Record<string, unknown>)[key] = (record as Record<string, unknown>)[key];
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Method decorator: filters the handler's result to fields `read`-permitted on `subjectType`. */
export function PermittedFields(subjectType: string) {
  return <T extends (this: any, ctx: Ctx<any>) => unknown>(
    method: T,
    _context: ClassMethodDecoratorContext,
  ): T => {
    const wrapped = async function (this: unknown, ctx: Ctx<any>) {
      const pending = cachedAbility(ctx as AbilityCtx);
      const ability = pending ? await pending : null;
      if (!ability) throw new ForbiddenException('PermittedFields requires AbilityGuard');
      const result = await method.call(this, ctx);
      if (Array.isArray(result)) {
        return result.map((item) =>
          isPlainObject(item) ? pickPermitted(ability, subjectType, item) : item,
        );
      }
      return isPlainObject(result) ? pickPermitted(ability, subjectType, result) : result;
    };
    return wrapped as unknown as T;
  };
}
