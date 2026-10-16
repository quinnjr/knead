import { describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import { MemoryLogger } from '../src/logger.js';
import {
  checkBunVersion,
  compareVersions,
  MIN_BUN_VERSION,
  resetBunVersionWarning,
} from '../src/runtime-version.js';
import { start } from './helpers.js';

describe('Bun version check', () => {
  test('compareVersions orders major.minor.patch numerically', () => {
    expect(compareVersions('1.4.2', '1.4.3')).toBeLessThan(0);
    expect(compareVersions('1.4.3', '1.4.3')).toBe(0);
    expect(compareVersions('1.4.10', '1.4.3')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.4.3')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.4.3-canary.1+abc', '1.4.3')).toBe(0);
    expect(compareVersions('1.4', '1.4.3')).toBeLessThan(0);
  });

  test('warns once below 1.4.3, never at or above it', () => {
    expect(MIN_BUN_VERSION).toBe('1.4.3');
    resetBunVersionWarning();
    const logger = new MemoryLogger();
    expect(checkBunVersion(logger, '1.4.2')).toBe(false);
    expect(checkBunVersion(logger, '1.3.0')).toBe(false);
    expect(logger.entries.filter((e) => e.message.includes('CVE-2026-48618'))).toHaveLength(1);
    resetBunVersionWarning();
    const current = new MemoryLogger();
    expect(checkBunVersion(current, '1.4.3')).toBe(true);
    expect(checkBunVersion(current, '1.5.0')).toBe(true);
    expect(current.entries).toEqual([]);
  });

  test('listen() checks the running Bun', async () => {
    resetBunVersionWarning();
    @Module({})
    class M {}
    const app = await start(M);
    const warned = (app.logger as MemoryLogger).entries.some((e) =>
      e.message.includes('CVE-2026-48618'),
    );
    expect(warned).toBe(compareVersions(Bun.version, '1.4.3') < 0);
    await app.close();
  });
});
