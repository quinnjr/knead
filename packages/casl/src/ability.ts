import {
  detectSubjectType as caslDetectSubjectType,
  createMongoAbility,
  fieldPatternMatcher,
  type MongoAbility,
  type RawRuleOf,
} from '@casl/ability';
import type { Grant } from './grant.js';
import type { Permissions } from './permissions.js';

export type AppAbility = MongoAbility;

type Rule = RawRuleOf<MongoAbility>;

const subjectTypes = new WeakMap<object, string>();

/**
 * Records that `record` is of CASL subject type `type` without mutating it; returns record.
 * Tagging the same object again replaces its previous type.
 */
export function asSubject<T extends object>(type: string, record: T): T {
  subjectTypes.set(record, type);
  return record;
}

function detectSubjectType(subject: object): string {
  return subjectTypes.get(subject) ?? caslDetectSubjectType(subject);
}

export function createAppAbility(rules: Rule[]): AppAbility {
  return createMongoAbility(rules, { detectSubjectType });
}

const list = <T>(v: T | readonly T[]): T[] => (Array.isArray(v) ? [...v] : [v as T]);

/**
 * `wildcard` on either side matches everything and keeps the other side's names. Non-string
 * user subjects (classes) only ever match by identity, so they never match catalog strings.
 */
function intersectNames<T>(u: T | readonly T[], g: T | readonly T[], wildcard: T): T[] {
  const us = list(u);
  const gs = list(g);
  if (us.includes(wildcard)) return gs;
  if (gs.includes(wildcard)) return us;
  return [...new Set(us.filter((x) => gs.includes(x)))];
}

/** undefined = no field restriction; [] = nothing allowed. */
function intersectFields(
  u: string | readonly string[] | undefined,
  g: string | readonly string[] | undefined,
): string[] | undefined {
  if (u === undefined) return g === undefined ? undefined : list(g);
  if (g === undefined) return list(u);
  const matches = fieldPatternMatcher(list(u));
  return list(g).filter((f) => matches(f));
}

/**
 * Rules allowed by both sides. `userRules` may have conditions/fields/inverted; grant rules are
 * catalog rules.
 *
 * User rules are walked once, in order: each positive rule is replaced, at its own position, by
 * its intersections with every grant rule (in grant order), and each inverted rule is kept
 * unchanged at its original position. CASL lets later rules win, so preserving order keeps the
 * user's own priority intact. This never widens: every emitted positive rule is a subset of the
 * user rule it replaces (and of a grant rule), and every `cannot` stays where it was.
 */
export function intersectRules(userRules: Rule[], grantRules: Rule[]): Rule[] {
  const out: Rule[] = [];
  for (const u of userRules) {
    if (u.inverted) {
      out.push(u);
      continue;
    }
    for (const g of grantRules) {
      const action = intersectNames(u.action, g.action, 'manage');
      const subject = intersectNames(u.subject ?? 'all', g.subject ?? 'all', 'all');
      if (action.length === 0 || subject.length === 0) continue;
      const fields = intersectFields(u.fields, g.fields);
      if (fields?.length === 0) continue;
      out.push({
        action,
        subject,
        ...(u.conditions !== undefined && { conditions: u.conditions }),
        ...(fields !== undefined && { fields }),
      } as Rule);
    }
  }
  return out;
}

export function grantRules(grant: Grant, permissions: Permissions): Rule[] {
  const out: Rule[] = [];
  for (const area of Object.keys(grant)) {
    out.push(...permissions.rulesFor(area, grant[area]!));
  }
  return out;
}
