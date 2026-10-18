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
  expect(Bun.inspect(config)).toBe('Config {"jwtSecret":"[redacted]"}');
  expect(Bun.inspect({ nested: config })).toBe(
    '{\n  nested: Config {"jwtSecret":"[redacted]"},\n}',
  );
});
test('data is deep-frozen', () => {
  const config = new Config({ db: { host: 'h' }, list: [{ a: 1 }] });
  expect(Object.isFrozen(config.all())).toBe(true);
  expect(Object.isFrozen(config.get('db'))).toBe(true);
  expect(Object.isFrozen(config.get('list'))).toBe(true);
  expect(Object.isFrozen(config.get('list')[0])).toBe(true);
});
test('deep-freezes children of an already shallow-frozen object, and handles cycles', () => {
  const config = new Config(Object.freeze({ db: { host: 'h' } }));
  expect(Object.isFrozen(config.get('db'))).toBe(true);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(Object.isFrozen(new Config(cyclic).all())).toBe(true);
});
test('freezes own enumerable properties only: Map, Set and Date contents stay mutable', () => {
  const config = new Config({
    map: new Map([['a', 1]]),
    set: new Set([1]),
    date: new Date(0),
  });
  expect(Object.isFrozen(config.get('map'))).toBe(true);
  config.get('map').set('b', 2);
  config.get('set').add(2);
  config.get('date').setTime(1);
  expect(config.get('map').get('b')).toBe(2);
  expect(config.get('set').has(2)).toBe(true);
  expect(config.get('date').getTime()).toBe(1);
});
test('typed arrays, Buffers and ArrayBuffers are kept as they are: their bytes stay mutable', () => {
  const bytes = new Uint8Array([1, 2]);
  const buffer = Buffer.from('key');
  const raw = new ArrayBuffer(4);
  const config = new Config({ bytes, buffer, raw, nested: { bytes } });
  expect(Object.isFrozen(config.all())).toBe(true);
  expect(Object.isFrozen(config.get('nested'))).toBe(true);
  expect(config.get('bytes')).toBe(bytes);
  expect(config.get('buffer').toString()).toBe('key');
  config.get('bytes')[0] = 9;
  expect(bytes[0]).toBe(9);
  expect(config.get('raw').byteLength).toBe(4);
});
test('objects under symbol keys are frozen too', () => {
  const key = Symbol('nested');
  const config = new Config({ db: { [key]: { host: 'h' } } });
  expect(Object.isFrozen(config.get('db')[key])).toBe(true);
});
