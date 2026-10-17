import type { Permissions } from './permissions.js';

/** Validated area → level map; areas absent are at levels[0]. Frozen, null-prototype. */
export type Grant = Readonly<Record<string, string>>;

export const MAX_SCOPE_LENGTH = 4096;

const SKIPPED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function build(pairs: [string, string][], permissions: Permissions): Grant | null {
  const out: Record<string, string> = Object.create(null);
  for (const [area, level] of pairs) {
    if (!Object.hasOwn(permissions.areas, area)) return null;
    const def = permissions.areas[area];
    if (!def?.levels.includes(level)) return null;
    out[area] = level;
  }
  return Object.freeze(out);
}

function parseEntries(entries: readonly unknown[], permissions: Permissions): Grant | null {
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length > MAX_SCOPE_LENGTH) return null;
    const i = entry.indexOf(':');
    if (i <= 0) return null;
    const area = entry.slice(0, i);
    if (seen.has(area)) return null;
    seen.add(area);
    pairs.push([area, entry.slice(i + 1)]);
  }
  return build(pairs, permissions);
}

/** null = malformed (caller denies everything). undefined input also returns null. */
export function parseGrant(input: unknown, permissions: Permissions): Grant | null {
  const areaCount = Object.keys(permissions.areas).length;
  if (typeof input === 'string') {
    if (input.length > MAX_SCOPE_LENGTH) return null;
    const entries = input.split(' ').filter((s) => s !== '');
    if (entries.length > areaCount) return null;
    return parseEntries(entries, permissions);
  }
  if (Array.isArray(input)) {
    if (input.length > areaCount) return null;
    return parseEntries(input, permissions);
  }
  if (typeof input === 'object' && input !== null) {
    const pairs: [string, string][] = [];
    for (const key of Object.keys(input)) {
      if (SKIPPED_KEYS.has(key)) continue;
      const level = (input as Record<string, unknown>)[key];
      if (typeof level !== 'string') return null;
      pairs.push([key, level]);
    }
    if (pairs.length > areaCount) return null;
    return build(pairs, permissions);
  }
  return null;
}
