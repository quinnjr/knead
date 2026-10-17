import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkCommitIsRefHead,
  checkReleaseTag,
  checkRepositoryFields,
  checkVersionAtRef,
  publishablePackages,
  REPOSITORY_URL,
  revParse,
  versionsAtRef,
} from './release';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(pkgs: Record<string, object>): string {
  const root = mkdtempSync(join(tmpdir(), 'knead-release-test-'));
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
      http: pkg('@knead-js/http', '1.2.3'),
      core: pkg('@knead-js/core', '1.2.3'),
      internal: { ...pkg('@knead-js/internal', '1.2.3'), private: true },
    });
    expect(publishablePackages(root).map((p) => p.name)).toEqual([
      '@knead-js/core',
      '@knead-js/http',
    ]);
  });
});

describe('checkReleaseTag', () => {
  const pkgs = [pkg('@knead-js/core', '1.2.3'), pkg('@knead-js/http', '1.2.3')];

  test('passes when the tag matches every package version', () => {
    expect(checkReleaseTag('v1.2.3', pkgs)).toEqual([]);
  });

  test('accepts a refs/tags/ prefix and prerelease versions', () => {
    const pre = [pkg('@knead-js/core', '2.0.0-next.1')];
    expect(checkReleaseTag('refs/tags/v2.0.0-next.1', pre)).toEqual([]);
  });

  test('fails when any package version differs from the tag', () => {
    const problems = checkReleaseTag('v1.2.4', pkgs);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('@knead-js/core');
    expect(problems[0]).toContain('1.2.3');
  });

  test('fails when one package drifted from the shared version', () => {
    const drifted = [...pkgs, pkg('@knead-js/cors', '1.2.2')];
    expect(checkReleaseTag('v1.2.3', drifted)).toEqual([
      '@knead-js/cors is at 1.2.2 but the tag is v1.2.3',
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
      core: { ...pkg('@knead-js/core', '1.0.0'), repository: repo('core') },
      http: { ...pkg('@knead-js/http', '1.0.0'), repository: repo('http') },
    });
    expect(checkRepositoryFields(publishablePackages(root))).toEqual([]);
  });

  test('fails when repository is missing', () => {
    const root = workspace({ core: pkg('@knead-js/core', '1.0.0') });
    expect(checkRepositoryFields(publishablePackages(root))).toEqual([
      `@knead-js/core: repository.url must be ${REPOSITORY_URL}`,
      '@knead-js/core: repository.directory must be packages/core',
    ]);
  });

  test('fails on a string shorthand, another repository or the wrong directory', () => {
    const root = workspace({
      core: { ...pkg('@knead-js/core', '1.0.0'), repository: 'github:quinnjr/other' },
      cors: {
        ...pkg('@knead-js/cors', '1.0.0'),
        repository: { ...repo('cors'), url: 'git+https://github.com/someone/fork.git' },
      },
      http: { ...pkg('@knead-js/http', '1.0.0'), repository: repo('core') },
    });
    const problems = checkRepositoryFields(publishablePackages(root));
    expect(problems).toContain(`@knead-js/core: repository.url must be ${REPOSITORY_URL}`);
    expect(problems).toContain('@knead-js/core: repository.directory must be packages/core');
    expect(problems).toContain(`@knead-js/cors: repository.url must be ${REPOSITORY_URL}`);
    expect(problems).toContain('@knead-js/http: repository.directory must be packages/http');
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
    { name: '@knead-js/core', version },
    { name: '@knead-js/http', version },
  ];

  test('passes when the tag is the version at the ref', () => {
    expect(checkVersionAtRef('v1.2.3', 'origin/main', at('1.2.3'))).toEqual([]);
    expect(checkVersionAtRef('refs/tags/v1.2.3', 'origin/main', at('1.2.3'))).toEqual([]);
  });

  test('fails when main has moved past the tag (an old main commit)', () => {
    expect(checkVersionAtRef('v1.2.3', 'origin/main', at('1.3.0'))).toEqual([
      '@knead-js/core is at 1.3.0 at origin/main but the tag is v1.2.3',
      '@knead-js/http is at 1.3.0 at origin/main but the tag is v1.2.3',
    ]);
  });

  test('fails when a package does not exist at the ref', () => {
    expect(checkVersionAtRef('v1.2.3', 'origin/main', at(undefined))[0]).toBe(
      '@knead-js/core does not exist at origin/main',
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
    const root = workspace({ core: pkg('@knead-js/core', '1.0.0') });
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'one');
    writeFileSync(
      join(root, 'packages/core/package.json'),
      JSON.stringify(pkg('@knead-js/core', '2.0.0')),
    );
    const packages = [
      ...publishablePackages(root),
      { name: '@knead-js/new', relativeDir: 'packages/new' },
    ];
    expect(versionsAtRef(root, 'main', packages)).toEqual([
      { name: '@knead-js/core', version: '1.0.0' },
      { name: '@knead-js/new', version: undefined },
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
    expect(allowed).toHaveLength(11);
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

describe('checkCommitIsRefHead', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);

  test('passes when the commit is the head of the ref', () => {
    expect(checkCommitIsRefHead(a, a, 'origin/main')).toEqual([]);
  });

  test('fails for any other commit, such as an older main commit', () => {
    expect(checkCommitIsRefHead(a, b, 'origin/main')).toEqual([
      `the tagged commit ${a} is not the head of origin/main (${b}); tag main's HEAD`,
    ]);
  });

  test('fails when the ref cannot be resolved', () => {
    expect(checkCommitIsRefHead(a, undefined, 'origin/main')).toEqual([
      'origin/main could not be resolved',
    ]);
  });
});

describe('revParse', () => {
  test('resolves a ref to its commit, and undefined for an unknown ref', () => {
    const root = workspace({ core: pkg('@knead-js/core', '1.0.0') });
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'one');
    expect(revParse(root, 'main')).toBe(git('rev-parse', 'HEAD'));
    expect(revParse(root, 'no-such-ref')).toBeUndefined();
  });
});
