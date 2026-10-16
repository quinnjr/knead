import { inject } from '@knead-js/core';
import type { Guard } from '@knead-js/http';
import { CAN, type CanRequirement, SKIP } from './metadata.js';
import type { AbilityCtx } from './options.js';
import { AbilityService } from './service.js';

/**
 * Passes `@SkipAbility()` routes; otherwise requires the route's `@Can()` against the caller's
 * ability. A route without `@Can()` is denied (fail closed).
 */
export class AbilityGuard implements Guard<AbilityCtx> {
  readonly #abilities = inject(AbilityService);

  async canActivate(ctx: AbilityCtx): Promise<boolean> {
    if (ctx.meta[SKIP] === true) return true;
    const required = ctx.meta[CAN] as CanRequirement | undefined;
    if (!required) return false;
    const ability = await this.#abilities.forCtx(ctx);
    return ability.can(required.action, required.subject, required.field) === true;
  }
}
