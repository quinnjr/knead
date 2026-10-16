import { expect, test } from 'bun:test';
import { Config } from '../src/config.js';

test('get returns typed values and all() returns the data', () => {
  const config = new Config({ jwtSecret: 's3cret', port: 1 });
  const port: number = config.get('port');
  expect(port).toBe(1);
  expect(config.get('jwtSecret')).toBe('s3cret');
  expect(config.all()).toEqual({ jwtSecret: 's3cret', port: 1 });
  // @ts-expect-error unknown key
  config.get('nope');
});
test('JSON.stringify redacts every value', () => {
  expect(JSON.stringify(new Config({ jwtSecret: 's3cret', port: 1 }))).toBe(
    '{"jwtSecret":"[redacted]","port":"[redacted]"}',
  );
});
test('inspect never shows values', () => {
  const config = new Config({ jwtSecret: 's3cret' });
  expect(Bun.inspect(config)).not.toContain('s3cret');
  expect(Bun.inspect({ nested: config })).not.toContain('s3cret');
});
test('data is deep-frozen', () => {
  const config = new Config({ db: { host: 'h' }, list: [{ a: 1 }] });
  expect(Object.isFrozen(config.all())).toBe(true);
  expect(Object.isFrozen(config.get('db'))).toBe(true);
  expect(Object.isFrozen(config.get('list'))).toBe(true);
  expect(Object.isFrozen(config.get('list')[0])).toBe(true);
});
