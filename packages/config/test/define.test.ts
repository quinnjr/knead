import { expect, test } from 'bun:test';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import { type } from 'arktype';
import * as v from 'valibot';
import { z } from 'zod';
import { defineConfig } from '../src/define.js';
import { ConfigDefinitionError } from '../src/errors.js';

const expected = new Set(['databaseUrl', 'port']);

test('reads declared keys from zod', () => {
  const handle = defineConfig(z.object({ databaseUrl: z.string(), port: z.coerce.number() }));
  expect(handle.keys).toEqual(expected);
  expect(handle.description).toBe('Config');
});
test('reads declared keys from arktype', () => {
  expect(defineConfig(type({ databaseUrl: 'string', port: 'string' })).keys).toEqual(expected);
});
test('reads declared keys from valibot', () => {
  const schema = toStandardJsonSchema(v.object({ databaseUrl: v.string(), port: v.number() }));
  expect(defineConfig(schema).keys).toEqual(expected);
});
test('uses the given name as the token description', () => {
  expect(defineConfig(z.object({ a: z.string() }), { name: 'AppConfig' }).description).toBe(
    'AppConfig',
  );
});
test('rejects a schema without ~standard.jsonSchema', () => {
  const schema = {
    '~standard': { version: 1, vendor: 'x', validate: (x: unknown) => ({ value: x }) },
  };
  expect(() => defineConfig(schema as never)).toThrow(ConfigDefinitionError);
  expect(() => defineConfig(schema as never)).toThrow(/Standard JSON Schema/);
});
test('rejects a non-object top level', () => {
  expect(() => defineConfig(z.string() as never)).toThrow(ConfigDefinitionError);
});
test('rejects keys env can never produce, suggesting the camelCase form', () => {
  for (const [key, suggestion] of [
    ['DATABASE_URL', 'databaseUrl'],
    ['api_key', 'apiKey'],
    ['Port', 'port'],
  ] as const) {
    const make = () => defineConfig(z.object({ [key]: z.string() }));
    expect(make).toThrow(ConfigDefinitionError);
    expect(make).toThrow(`"${key}"`);
    expect(make).toThrow(`"${suggestion}"`);
  }
});
test('accepts camelCase keys with digits and acronyms', () => {
  expect(
    defineConfig(z.object({ oauth2ClientId: z.string(), awsRegion: z.string() })).keys,
  ).toEqual(new Set(['oauth2ClientId', 'awsRegion']));
});
test('arktype morph schemas still expose their keys', () => {
  expect(defineConfig(type({ port: 'string.numeric.parse' })).keys).toEqual(new Set(['port']));
});
test('rejects array-shaped properties with a plain-object hint', () => {
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'x',
      validate: (x: unknown) => ({ value: x }),
      jsonSchema: { input: () => ({ type: 'object', properties: ['a'] }), output: () => ({}) },
    },
  };
  expect(() => defineConfig(schema as never)).toThrow(ConfigDefinitionError);
  expect(() => defineConfig(schema as never)).toThrow(/plain object schema/);
  expect(() => defineConfig(z.string() as never)).toThrow(/\$ref\/allOf\/anyOf/);
});
test('wraps a JSON Schema conversion failure with its cause', () => {
  let error: unknown;
  try {
    defineConfig(z.object({ n: z.bigint() }));
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ConfigDefinitionError);
  expect((error as Error).message).toBe('Could not convert the config schema to JSON Schema.');
  expect((error as Error).cause).toBeInstanceOf(Error);
  expect(((error as Error).cause as Error).message).toContain('BigInt');
});
