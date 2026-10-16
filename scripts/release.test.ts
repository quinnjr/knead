import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkReleaseTag,
  checkRepositoryFields,
  checkVersionAtRef,
  publishablePackages,
  REPOSITORY_URL,
  versionsAtRef,
} from './release';

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

describe('checkRepositoryFields', () => {
  const repo = (dir: string) => ({
    type: 'git',
    url: REPOSITORY_URL,
    directory: `packages/${dir}`,
  });

  test('passes when every package points at its own directory in this repository', () => {
    const root = workspace({
      core: { ...pkg('@hpmws/core', '1.0.0'), repository: repo('core') },
      http: { ...pkg('@hpmws/http', '1.0.0'), repository: repo('http') },
    });
    expect(checkRepositoryFields(publishablePackages(root))).toEqual([]);
  });

  test('fails when repository is missing', () => {
    const root = workspace({ core: pkg('@hpmws/core', '1.0.0') });
    expect(checkRepositoryFields(publishablePackages(root))).toEqual([
      `@hpmws/core: repository.url must be ${REPOSITORY_URL}`,
      '@hpmws/core: repository.directory must be packages/core',
    ]);
  });

  test('fails on a string shorthand, another repository or the wrong directory', () => {
    const root = workspace({
      core: { ...pkg('@hpmws/core', '1.0.0'), repository: 'github:quinnjr/other' },
      cors: {
        ...pkg('@hpmws/cors', '1.0.0'),
        repository: { ...repo('cors'), url: 'git+https://github.com/someone/fork.git' },
      },
      http: { ...pkg('@hpmws/http', '1.0.0'), repository: repo('core') },
    });
    const problems = checkRepositoryFields(publishablePackages(root));
    expect(problems).toContain(`@hpmws/core: repository.url must be ${REPOSITORY_URL}`);
    expect(problems).toContain('@hpmws/core: repository.directory must be packages/core');
    expect(problems).toContain(`@hpmws/cors: repository.url must be ${REPOSITORY_URL}`);
    expect(problems).toContain('@hpmws/http: repository.directory must be packages/http');
    expect(problems).toHaveLength(4);
  });
});

describe('workspace packages', () => {
  test('every publishable package declares this repository', () => {
    expect(checkRepositoryFields(publishablePackages(join(import.meta.dir, '..')))).toEqual([]);
  });
});

describe('checkVersionAtRef', () => {
  const at = (version: string | undefined) => [
    { name: '@hpmws/core', version },
    { name: '@hpmws/http', version },
  ];

  test('passes when the tag is the version at the ref', () => {
    expect(checkVersionAtRef('v1.2.3', 'origin/main', at('1.2.3'))).toEqual([]);
    expect(checkVersionAtRef('refs/tags/v1.2.3', 'origin/main', at('1.2.3'))).toEqual([]);
  });

  test('fails when main has moved past the tag (an old main commit)', () => {
    expect(checkVersionAtRef('v1.2.3', 'origin/main', at('1.3.0'))).toEqual([
      '@hpmws/core is at 1.3.0 at origin/main but the tag is v1.2.3',
      '@hpmws/http is at 1.3.0 at origin/main but the tag is v1.2.3',
    ]);
  });

  test('fails when a package does not exist at the ref', () => {
    expect(checkVersionAtRef('v1.2.3', 'origin/main', at(undefined))[0]).toBe(
      '@hpmws/core does not exist at origin/main',
    );
  });

  test('rejects malformed tags and an empty package list', () => {
    expect(checkVersionAtRef('1.2.3', 'origin/main', at('1.2.3'))[0]).toContain(
      'not a release tag',
    );
    expect(checkVersionAtRef('v1.2.3', 'origin/main', [])[0]).toContain('no publishable packages');
  });
});

describe('versionsAtRef', () => {
  test('reads each package version from the given git ref, not the working tree', () => {
    const root = workspace({ core: pkg('@hpmws/core', '1.0.0') });
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'one');
    writeFileSync(
      join(root, 'packages/core/package.json'),
      JSON.stringify(pkg('@hpmws/core', '2.0.0')),
    );
    const packages = [
      ...publishablePackages(root),
      { name: '@hpmws/new', relativeDir: 'packages/new' },
    ];
    expect(versionsAtRef(root, 'main', packages)).toEqual([
      { name: '@hpmws/core', version: '1.0.0' },
      { name: '@hpmws/new', version: undefined },
    ]);
  });
});

describe('release.yml publish allowlist', () => {
  test('equals the publishable workspace packages', () => {
    const workflow = Bun.YAML.parse(
      readFileSync(join(import.meta.dir, '../.github/workflows/release.yml'), 'utf8'),
    ) as { jobs: { publish: { steps: { name?: string; env?: Record<string, string> }[] } } };
    const step = workflow.jobs.publish.steps.find((s) => s.name === 'Publish tarballs');
    const allowed = String(step?.env?.ALLOWED_PACKAGES ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const names = publishablePackages(join(import.meta.dir, '..')).map((p) => p.name);
    expect(allowed).toEqual(names);
    expect(allowed).toHaveLength(8);
  });
});

describe('release.yml dependency allowlist', () => {
  test("lists exactly each publishable package's dependencies, optional and peer dependencies", () => {
    const root = join(import.meta.dir, '..');
    const workflow = Bun.YAML.parse(
      readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'),
    ) as { jobs: { publish: { steps: { name?: string; env?: Record<string, string> }[] } } };
    const step = workflow.jobs.publish.steps.find((s) => s.name === 'Publish tarballs');
    const allowed = Object.fromEntries(
      String(step?.env?.ALLOWED_DEPENDENCIES ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, deps = ''] = line.split(':');
          return [name.trim(), deps.split(/\s+/).filter(Boolean).sort()];
        }),
    );
    const actual = Object.fromEntries(
      publishablePackages(root).map((p) => {
        const manifest = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8'));
        const deps = new Set<string>();
        for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'])
          for (const dep of Object.keys(manifest[field] ?? {})) deps.add(dep);
        return [p.name, [...deps].sort()];
      }),
    );
    expect(allowed).toEqual(actual);
  });
});
