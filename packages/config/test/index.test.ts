import { expect, test } from 'bun:test';
import * as api from '../src/index.js';

test('the public API does not expose key-conversion internals', () => {
  expect(Object.keys(api).sort()).toEqual([
    'Config',
    'ConfigDefinitionError',
    'ConfigError',
    'ConfigHandle',
    'ConfigKeyCollisionError',
    'ConfigLoaderError',
    'ConfigModule',
    'ConfigValidationError',
    'defineConfig',
    'loadConfig',
  ]);
});
