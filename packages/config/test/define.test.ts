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
