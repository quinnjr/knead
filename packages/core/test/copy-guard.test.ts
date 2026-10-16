import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { CORE_COPY_KEY, CORE_COPY_WARNED_KEY, registerCoreCopy } from '../src/copy-guard.js';
import '../src/index.js';

const store = globalThis as Record<symbol, unknown>;

describe('duplicate @knead/core guard', () => {
  const original = store[CORE_COPY_KEY];
  afterEach(() => {
    store[CORE_COPY_KEY] = original;
    store[CORE_COPY_WARNED_KEY] = undefined;
  });

  test('loading the package records its identity on globalThis', () => {
    expect(CORE_COPY_KEY as symbol).toBe(Symbol.for('knead.core'));
    expect(store[CORE_COPY_KEY]).toMatchObject({ url: expect.stringContaining('copy-guard') });
  });

  test('a second, different copy warns once', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      store[CORE_COPY_KEY] = {
        url: 'file:///elsewhere/node_modules/@knead/core/dist/copy-guard.js',
      };
      registerCoreCopy({ url: 'file:///app/node_modules/@knead/core/dist/copy-guard.js' });
      registerCoreCopy({ url: 'file:///third/node_modules/@knead/core/dist/copy-guard.js' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('Multiple copies of @knead/core');
      expect(String(warn.mock.calls[0]?.[0])).toContain('inject()');
    } finally {
      warn.mockRestore();
    }
  });

  test('the same copy registering again does not warn', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const marker = { url: 'file:///app/core.js' };
      store[CORE_COPY_KEY] = undefined;
      registerCoreCopy(marker);
      registerCoreCopy({ url: 'file:///app/core.js' });
      expect(warn).not.toHaveBeenCalled();
      expect(store[CORE_COPY_KEY]).toBe(marker);
    } finally {
      warn.mockRestore();
    }
  });

  test('importing a fresh module instance with a pre-set marker warns', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      store[CORE_COPY_KEY] = { url: 'file:///other-copy/copy-guard.js' };
      // A query string makes Bun evaluate a second, independent module instance.
      const specifier = '../src/copy-guard.js?fresh-copy';
      await import(specifier);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
