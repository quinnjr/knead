import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { PresetName, SanitizePolicy } from './policies.js';
import { assertSafePolicy, sanitize } from './sanitize.js';

/** Validates with `inner`, then sanitizes its (string) output against an allowlist policy. */
export function sanitizedHtml<S extends StandardSchemaV1>(
  inner: S,
  policy: SanitizePolicy | PresetName = 'basic',
): StandardSchemaV1<StandardSchemaV1.InferInput<S>, string> {
  if (typeof policy !== 'string') assertSafePolicy(policy);
  return {
    '~standard': {
      version: 1,
      vendor: 'hpmws',
      async validate(value) {
        const result = await inner['~standard'].validate(value);
        if (result.issues) return { issues: result.issues };
        if (typeof result.value !== 'string') {
          return {
            issues: [{ message: 'sanitizedHtml() requires the inner schema to output a string' }],
          };
        }
        return { value: sanitize(result.value, policy) };
      },
    },
  };
}
