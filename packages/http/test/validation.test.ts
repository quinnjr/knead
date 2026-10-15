import { describe, expect, test } from 'bun:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { BadRequestException } from '../src/exceptions.js';
import { ValidationException, validateRequest } from '../src/validation.js';
import { makeCtx } from './helpers.js';

/** Minimal Standard Schema: object with required string fields, optional async validation. */
function requireStrings<T extends string>(
  keys: T[],
  options: { async?: boolean; coerceNumber?: T } = {},
) {
  const schema: StandardSchemaV1<unknown, Record<T, unknown>> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value) {
        const issues: StandardSchemaV1.Issue[] = [];
        const input = (value ?? {}) as Record<string, unknown>;
        for (const k of keys) {
          if (typeof input[k] !== 'string')
            issues.push({ message: `${k} is required`, path: [{ key: k }] });
        }
        const out = issues.length
          ? { issues }
          : {
              value: Object.fromEntries(
                keys.map((k) => [k, k === options.coerceNumber ? Number(input[k]) : input[k]]),
              ) as Record<T, unknown>,
            };
        return options.async ? Promise.resolve(out) : out;
      },
    },
  };
  return schema;
}

const jsonPost = (path: string, body: string) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  });

describe('validateRequest', () => {
  test('replaces sources with schema output', async () => {
    const ctx = makeCtx(jsonPost('/?page=3', '{"name":"Ada"}'));
    await validateRequest(ctx, {
      query: requireStrings(['page'], { coerceNumber: 'page' }),
      body: requireStrings(['name'], { async: true }),
    });
    expect(ctx.query).toEqual({ page: 3 });
    expect(ctx.body).toEqual({ name: 'Ada' });
  });

  test('aggregates issues from every source with normalized paths', async () => {
    const ctx = makeCtx(jsonPost('/', '{}'));
    const error = await validateRequest(ctx, {
      query: requireStrings(['page']),
      body: requireStrings(['name']),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationException);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.issues).toEqual([
      { source: 'query', message: 'page is required', path: ['page'] },
      { source: 'body', message: 'name is required', path: ['name'] },
    ]);
    expect(error.toProblem('/').issues).toEqual(error.issues);
    expect(error.detail).toBe('Request validation failed');
  });

  test('malformed bodies surface as BadRequestException, not validation issues', async () => {
    const ctx = makeCtx(jsonPost('/', '{oops'));
    const error = await validateRequest(ctx, { body: requireStrings(['name']) }).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).not.toBeInstanceOf(ValidationException);
  });

  test('no schemas leaves the context untouched and does not read the body', async () => {
    const ctx = makeCtx(jsonPost('/', '{"a":1}'));
    await validateRequest(ctx, {});
    expect(ctx.body).toBeUndefined();
    expect(await ctx.json()).toEqual({ a: 1 });
  });

  test('params and headers are replaced on success', async () => {
    const ctx = makeCtx(jsonPost('/', '{}'));
    ctx.params = { id: 'abc' };
    ctx.headers = { 'x-key': 'k' };
    await validateRequest(ctx, {
      params: requireStrings(['id']),
      headers: requireStrings(['x-key']),
    });
    expect(ctx.params).toEqual({ id: 'abc' });
    expect(ctx.headers).toEqual({ 'x-key': 'k' });
  });

  test('params and headers issues carry their source', async () => {
    const ctx = makeCtx(jsonPost('/', '{}'));
    ctx.params = {};
    ctx.headers = {};
    const error = await validateRequest(ctx, {
      params: requireStrings(['id']),
      headers: requireStrings(['x-key']),
    }).catch((e) => e);
    expect(error.issues).toEqual([
      { source: 'params', message: 'id is required', path: ['id'] },
      { source: 'headers', message: 'x-key is required', path: ['x-key'] },
    ]);
  });
});
