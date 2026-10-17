import { expect, test } from 'bun:test';
import { ConfigLoaderError, ConfigValidationError } from '../src/errors.js';

test('ConfigLoaderError names the loader, or anonymous', () => {
  const cause = new Error('boom');
  const named = new ConfigLoaderError(2, 'ssm', { cause });
  expect(named.message).toBe('Config loader #2 (ssm) failed.');
  expect(named.index).toBe(2);
  expect(named.cause).toBe(cause);
  expect(new ConfigLoaderError(0, '', { cause }).message).toBe(
    'Config loader #0 (anonymous) failed.',
  );
});
test('ConfigLoaderError keeps cause non-enumerable', () => {
  const error = new ConfigLoaderError(0, 'x', { cause: new Error('boom') });
  expect(Object.getOwnPropertyDescriptor(error, 'cause')).toMatchObject({
    enumerable: false,
    writable: true,
    configurable: true,
  });
  expect(Object.keys(error)).not.toContain('cause');
});
test('ConfigValidationError lists one line per issue', () => {
  const error = new ConfigValidationError([
    { key: 'jwtSecret', name: 'JWT_SECRET', path: ['jwtSecret'], message: 'Missing value' },
    { key: 'db', name: 'DB', path: ['db', 'host'], message: 'Invalid value' },
  ]);
  expect(error.message).toBe(
    'Config validation failed:\n  JWT_SECRET (jwtSecret): Missing value\n  DB (db.host): Invalid value',
  );
  expect(error.issues).toHaveLength(2);
});
