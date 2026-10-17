import type { MongoAbility, RawRuleOf } from '@casl/ability';
import { CaslConfigError } from './errors.js';

export interface CatalogRule {
  action: string | readonly string[];
  subject: string | readonly string[];
  fields?: readonly string[];
}

export interface AreaDefinition<L extends string = string> {
  description?: string;
  /** Ordered; `levels[0]` means "no access". */
  levels: readonly [L, ...L[]];
  rules: Partial<Record<L, readonly CatalogRule[]>>;
}

export type Catalog = Record<string, AreaDefinition>;

export interface PermissionCatalogJson {
  areas: { name: string; description?: string; levels: string[] }[];
}

export interface Permissions<C extends Catalog = Catalog> {
  readonly areas: C;
  /** JSON-safe, deep-frozen; the same object on every call. */
  describe(): PermissionCatalogJson;
  /** Cumulative rules for `level` (that level and every lower level), as CASL raw rules. */
  rulesFor(area: keyof C & string, level: string): RawRuleOf<MongoAbility>[];
}

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const RULE_KEYS = new Set(['action', 'subject', 'fields']);

const own = (o: object, k: string): boolean => Object.hasOwn(o, k);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyStrings(v: unknown, where: string): string[] {
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list) || list.length === 0) {
    throw new CaslConfigError(`${where} must be a non-empty string or non-empty string array`);
  }
  for (const s of list) {
    if (typeof s !== 'string' || s === '') {
      throw new CaslConfigError(`${where} must contain only non-empty strings`);
    }
  }
  return [...(list as string[])];
}

interface StoredRule {
  action: string | string[];
  subject: string | string[];
  fields?: string[];
}

function copyRule(raw: unknown, where: string): StoredRule {
  if (!isRecord(raw)) throw new CaslConfigError(`${where} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.has(key)) {
      throw new CaslConfigError(
        `${where}: "${key}" is not supported (only action, subject and fields)`,
      );
    }
  }
  const action = nonEmptyStrings(raw.action, `${where}.action`);
  const subject = nonEmptyStrings(raw.subject, `${where}.subject`);
  const rule: StoredRule = {
    action: typeof raw.action === 'string' ? action[0]! : action,
    subject: typeof raw.subject === 'string' ? subject[0]! : subject,
  };
  if (own(raw, 'fields') && raw.fields !== undefined) {
    if (typeof raw.fields === 'string') {
      throw new CaslConfigError(`${where}.fields must be an array`);
    }
    const fields = nonEmptyStrings(raw.fields, `${where}.fields`);
    for (const f of fields) {
      if (f.includes('*')) throw new CaslConfigError(`${where}.fields must not contain "*"`);
    }
    rule.fields = fields;
  }
  return rule;
}

function cloneRule(r: StoredRule): RawRuleOf<MongoAbility> {
  const out: Record<string, unknown> = {
    action: Array.isArray(r.action) ? [...r.action] : r.action,
    subject: Array.isArray(r.subject) ? [...r.subject] : r.subject,
  };
  if (r.fields) out.fields = [...r.fields];
  return out as unknown as RawRuleOf<MongoAbility>;
}

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
}

export function definePermissions<const C extends Catalog>(areas: C): Permissions<C> {
  if (!isRecord(areas)) throw new CaslConfigError('permission catalog must be an object');
  const names = Object.keys(areas);
  if (names.length === 0) throw new CaslConfigError('permission catalog must define an area');

  const copy: Record<string, AreaDefinition> = {};
  const stored = new Map<string, { levels: string[]; rules: Map<string, StoredRule[]> }>();
  const json: PermissionCatalogJson['areas'] = [];

  for (const name of names) {
    if (!NAME.test(name)) {
      throw new CaslConfigError(`area name "${name}" must match ${NAME}`);
    }
    const def: unknown = areas[name];
    if (!isRecord(def)) throw new CaslConfigError(`area "${name}" must be an object`);
    if (def.description !== undefined && typeof def.description !== 'string') {
      throw new CaslConfigError(`area "${name}".description must be a string`);
    }
    const rawLevels = def.levels;
    if (!Array.isArray(rawLevels) || rawLevels.length === 0) {
      throw new CaslConfigError(`area "${name}".levels must be a non-empty array`);
    }
    const levels: string[] = [];
    for (const l of rawLevels) {
      if (typeof l !== 'string' || !NAME.test(l)) {
        throw new CaslConfigError(`area "${name}": level names must match ${NAME}`);
      }
      if (levels.includes(l)) throw new CaslConfigError(`area "${name}": duplicate level "${l}"`);
      levels.push(l);
    }
    const rawRules = def.rules;
    if (!isRecord(rawRules)) throw new CaslConfigError(`area "${name}".rules must be an object`);
    for (const key of Object.keys(rawRules)) {
      if (!levels.includes(key)) {
        throw new CaslConfigError(`area "${name}": rules key "${key}" is not a level`);
      }
      if (key === levels[0]) {
        throw new CaslConfigError(`area "${name}": level "${key}" means no access; no rules`);
      }
    }
    const rules = new Map<string, StoredRule[]>();
    const rulesCopy: Record<string, CatalogRule[]> = {};
    for (const level of levels.slice(1)) {
      const list = own(rawRules, level) ? rawRules[level] : undefined;
      if (!Array.isArray(list) || list.length === 0) {
        throw new CaslConfigError(`area "${name}": level "${level}" must add at least one rule`);
      }
      const parsed = list.map((r, i) => copyRule(r, `area "${name}".rules.${level}[${i}]`));
      rules.set(level, parsed);
      rulesCopy[level] = parsed.map(cloneRule) as CatalogRule[];
    }
    stored.set(name, { levels, rules });
    const description = def.description as string | undefined;
    copy[name] = {
      ...(description !== undefined && { description }),
      levels: [...levels],
      rules: rulesCopy,
    } as unknown as AreaDefinition;
    json.push({
      name,
      ...(description !== undefined && { description }),
      levels: [...levels],
    });
  }

  const frozenAreas = deepFreeze(copy) as C;
  const catalogJson = deepFreeze({ areas: json });

  return {
    areas: frozenAreas,
    describe: () => catalogJson,
    rulesFor(area, level) {
      const entry = stored.get(area);
      if (!entry) return [];
      const idx = entry.levels.indexOf(level);
      if (idx < 1) return [];
      const out: RawRuleOf<MongoAbility>[] = [];
      for (const l of entry.levels.slice(1, idx + 1)) {
        for (const r of entry.rules.get(l) ?? []) out.push(cloneRule(r));
      }
      return out;
    },
  };
}

/** The highest (last) level of every area. */
export function fullGrant<C extends Catalog>(p: Permissions<C>): Record<keyof C & string, string> {
  const out: Record<string, string> = {};
  for (const [name, def] of Object.entries(p.areas)) out[name] = def.levels[def.levels.length - 1]!;
  return out as Record<keyof C & string, string>;
}
