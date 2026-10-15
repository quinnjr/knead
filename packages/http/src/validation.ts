import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { RequestContext } from './context.js';
import { BadRequestException } from './exceptions.js';
import type { RouteOptions } from './types.js';

export type ValidationSource = 'params' | 'query' | 'headers' | 'body';

export interface ValidationIssue {
  source: ValidationSource;
  message: string;
  path: string[];
}

export class ValidationException extends BadRequestException {
  constructor(readonly issues: ValidationIssue[]) {
    super('Request validation failed', { extensions: { issues } });
  }
}

const SOURCES: readonly ValidationSource[] = ['params', 'query', 'headers', 'body'];

function segment(s: PropertyKey | StandardSchemaV1.PathSegment): string {
  return String(typeof s === 'object' ? s.key : s);
}

export async function validateRequest(
  ctx: RequestContext,
  schemas: Pick<RouteOptions, ValidationSource>,
): Promise<void> {
  const issues: ValidationIssue[] = [];
  for (const source of SOURCES) {
    const schema = schemas[source];
    if (!schema) continue;
    const input = source === 'body' ? await ctx.json() : ctx[source];
    const result = await schema['~standard'].validate(input);
    if (result.issues) {
      for (const issue of result.issues) {
        issues.push({ source, message: issue.message, path: (issue.path ?? []).map(segment) });
      }
    } else {
      (ctx as unknown as Record<ValidationSource, unknown>)[source] = result.value;
    }
  }
  if (issues.length > 0) throw new ValidationException(issues);
}
