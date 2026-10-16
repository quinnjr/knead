import { describe, expect, test } from 'bun:test';
import { AuthService } from '../src/auth/auth.js';
import { listenOptions } from '../src/config.js';

describe('demo AuthService', () => {
  test('refuses to start with NODE_ENV=production', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new AuthService()).toThrow(/demo tokens.*NODE_ENV=production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
    expect(() => new AuthService()).not.toThrow();
  });
});

describe('listen options', () => {
  test('bind to HOST, default 127.0.0.1', () => {
    expect(listenOptions({})).toEqual({ hostname: '127.0.0.1', port: 3000 });
    expect(listenOptions({ HOST: '0.0.0.0', PORT: '8080' })).toEqual({
      hostname: '0.0.0.0',
      port: 8080,
    });
  });
});
