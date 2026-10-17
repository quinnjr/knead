/** @internal Validation helpers for providers and @Injectable(), kept out of the public API. */

import { ProviderConfigError } from './errors.js';
import { redactCredentials } from './log-redaction.js';
import type { Scope } from './providers.js';

/** Most keys of an invalid provider object named in the error message. */
const DESCRIBED_KEYS = 8;
/** Longest key, or non-object value, quoted in the error message. */
const DESCRIBED_LENGTH = 64;

function clip(text: string): string {
  return text.length > DESCRIBED_LENGTH ? `${text.slice(0, DESCRIBED_LENGTH)}…` : text;
}

/**
 * A short description of an invalid provider: an object by its keys only (its values may be
 * credentials, such as a misspelled `provde` next to a connection string), anything else
 * redacted and capped.
 */
export function describe(value: unknown): string {
  try {
    if (typeof value === 'object' && value !== null) {
      const keys = Object.keys(value);
      const named = keys.slice(0, DESCRIBED_KEYS).map((key) => JSON.stringify(clip(key)));
      const more = keys.length > DESCRIBED_KEYS ? `, … ${keys.length - DESCRIBED_KEYS} more` : '';
      return `an object with keys ${named.join(', ') || '(none)'}${more}`;
    }
    return clip(redactCredentials(String(value)));
  } catch {
    return 'an unprintable value';
  }
}

/** `scope` when it is 'singleton' or 'transient'; anything else is a ProviderConfigError. */
export function checkScope(scope: unknown, owner: string): Scope {
  if (scope === 'singleton' || scope === 'transient') return scope;
  throw new ProviderConfigError(
    `Invalid scope ${JSON.stringify(describe(scope))} for ${owner}. Expected 'singleton' or 'transient'.`,
  );
}
