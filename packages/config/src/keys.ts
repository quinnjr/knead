import { ConfigKeyCollisionError } from './errors.js';

const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** Converts `DATABASE_URL` to `databaseUrl`; `undefined` when the key is not screaming snake. */
export function toCamelCase(key: string): string | undefined {
  if (!SCREAMING_SNAKE.test(key)) return undefined;
  return key
    .toLowerCase()
    .split('_')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

/**
 * Converts `jwtSecret` to `JWT_SECRET`. Names a missing key in errors, and lets defineConfig check
 * that a declared key round-trips from an environment name and build camelCase suggestions.
 */
export function toScreamingSnake(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
}

/** Converts one source's keys to declared camelCase keys; throws on a collision between two names. */
export function convertSource(
  source: Readonly<Record<string, unknown>>,
  declared: ReadonlySet<string>,
  sourceName: string,
): Map<string, { value: unknown; from: string }> {
  const out = new Map<string, { value: unknown; from: string }>();
  for (const [original, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const key = toCamelCase(original);
    if (key === undefined || !declared.has(key)) continue;
    const existing = out.get(key);
    if (existing) throw new ConfigKeyCollisionError(key, [existing.from, original], sourceName);
    out.set(key, { value, from: original });
  }
  return out;
}
