import { expect, test } from 'bun:test';
import { ConfigKeyCollisionError } from '../src/errors.js';
import { convertSource, toCamelCase, toScreamingSnake } from '../src/keys.js';

test('converts screaming snake to camelCase', () => {
  expect(toCamelCase('DATABASE_URL')).toBe('databaseUrl');
  expect(toCamelCase('PORT')).toBe('port');
  expect(toCamelCase('OAUTH2_CLIENT_ID')).toBe('oauth2ClientId');
  expect(toCamelCase('AWS_REGION')).toBe('awsRegion');
});
test('ignores keys that are not screaming snake', () => {
  for (const k of ['path', 'Path', '_FOO', 'FOO_', 'FOO__BAR', '1FOO', 'FOO-BAR', ''])
    expect(toCamelCase(k)).toBeUndefined();
});
test('toScreamingSnake names a camel key', () => {
  expect(toScreamingSnake('jwtSecret')).toBe('JWT_SECRET');
  expect(toScreamingSnake('oauth2ClientId')).toBe('OAUTH2_CLIENT_ID');
});
test('convertSource keeps only declared keys and empty strings', () => {
  const out = convertSource(
    { PORT: '', PATH: '/bin', JWT_SECRET: undefined },
    new Set(['port', 'jwtSecret']),
    'env',
  );
  expect([...out]).toEqual([['port', { value: '', from: 'PORT' }]]);
  expect(convertSource({ PATH: '/bin' }, new Set(['path']), 'env').get('path')?.value).toBe('/bin');
});
test('collision on a declared key throws, naming both', () => {
  expect(() => convertSource({ FOO_1: 'a', FOO1: 'b' }, new Set(['foo1']), 'env')).toThrow(
    ConfigKeyCollisionError,
  );
});
test('collision on an undeclared key is ignored', () => {
  expect(convertSource({ FOO_1: 'a', FOO1: 'b' }, new Set(['bar']), 'env').size).toBe(0);
});
