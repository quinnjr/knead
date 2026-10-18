import { AbilityService, type Grant } from '@knead-js/casl';
import { Injectable, inject } from '@knead-js/core';
import { BadRequestException } from '@knead-js/http';
import type { User } from './users.js';

// #region issuer
@Injectable()
export class TokenIssuer {
  readonly #abilities = inject(AbilityService);

  /** Returns the parsed, frozen grant to store with the new token. */
  async grantFor(user: User, requested: unknown): Promise<Grant> {
    const result = await this.#abilities.validateGrant(user, requested);
    if (!result.ok) {
      // [{ reason: 'malformed' }] or
      // [{ reason: 'exceeds-user', area, level, action, subject, field? }, ...]
      throw new BadRequestException('The token cannot be granted more than you can do', {
        extensions: { problems: result.problems },
      });
    }
    return result.grant;
  }
}
// #endregion issuer
