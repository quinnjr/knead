import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReleaseTag, publishablePackages } from './release';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(pkgs: Record<string, object>): string {
  const root = mkdtempSync(join(tmpdir(), 'hpmws-release-test-'));
  dirs.push(root);
  for (const [dir, manifest] of Object.entries(pkgs)) {
    mkdirSync(join(root, 'packages', dir), { recursive: true });
    writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify(manifest));
  }
  mkdirSync(join(root, 'packages', 'no-manifest'), { recursive: true });
  return root;
}

const pkg = (name: string, version: string) => ({ name, version });

describe('publishablePackages', () => {
  test('lists non-private packages under packages/, sorted by name', () => {
    const root = workspace({
      http: pkg('@hpmws/http', '1.2.3'),
      core: pkg('@hpmws/core', '1.2.3'),
      internal: { ...pkg('@hpmws/internal', '1.2.3'), private: true },
    });
    expect(publishablePackages(root).map((p) => p.name)).toEqual(['@hpmws/core', '@hpmws/http']);
  });
});

describe('checkReleaseTag', () => {
  const pkgs = [pkg('@hpmws/core', '1.2.3'), pkg('@hpmws/http', '1.2.3')];

  test('passes when the tag matches every package version', () => {
    expect(checkReleaseTag('v1.2.3', pkgs)).toEqual([]);
  });

  test('accepts a refs/tags/ prefix and prerelease versions', () => {
    const pre = [pkg('@hpmws/core', '2.0.0-next.1')];
    expect(checkReleaseTag('refs/tags/v2.0.0-next.1', pre)).toEqual([]);
  });

  test('fails when any package version differs from the tag', () => {
    const problems = checkReleaseTag('v1.2.4', pkgs);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('@hpmws/core');
    expect(problems[0]).toContain('1.2.3');
  });

  test('fails when one package drifted from the shared version', () => {
    const drifted = [...pkgs, pkg('@hpmws/cors', '1.2.2')];
    expect(checkReleaseTag('v1.2.3', drifted)).toEqual([
      '@hpmws/cors is at 1.2.2 but the tag is v1.2.3',
    ]);
  });

  test.each(['1.2.3', 'v1.2', 'v1.2.3.4', 'release-1.2.3', 'v01.2.3', 'v1.2.3 ', ''])(
    'rejects malformed tag %p',
    (tag) => {
      expect(checkReleaseTag(tag, pkgs)[0]).toContain('not a release tag');
    },
  );

  test('fails when there is nothing to publish', () => {
    expect(checkReleaseTag('v1.2.3', [])[0]).toContain('no publishable packages');
  });
});
