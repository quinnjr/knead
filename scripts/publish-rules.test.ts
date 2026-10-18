import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  exportTargets,
  loadPublishRules,
  parseAllowedDependencies,
  publishProblems,
  type TarEntry,
} from './publish-rules.js';

const rules = loadPublishRules(join(import.meta.dir, '../.github/workflows/release.yml'));

const files = (...names: string[]): TarEntry[] => names.map((name) => ({ type: '-', name }));
const shipped = files('package/package.json', 'package/README.md', 'package/dist/index.js');
const check = (manifest: Record<string, unknown>, entries: TarEntry[] = shipped) =>
  publishProblems({ name: '@knead-js/core', version: '1.2.3', ...manifest }, entries, rules);

describe('loadPublishRules', () => {
  test("reads the publish step's regexes, lifecycle filter and dependency allowlist", () => {
    expect(rules.entry.source).toStartWith('^');
    expect(rules.range.source).toStartWith('^');
    expect(rules.lifecycle.flags).toContain('i');
    expect(rules.allowedDependencies.get('@knead-js/core')).toEqual(new Set());
    expect(rules.allowedDependencies.get('@knead-js/prisma')).toEqual(
      new Set(['@knead-js/core', '@knead-js/http', '@prisma/client']),
    );
  });

  test('fails loudly when the workflow has no publish step', () => {
    expect(() => loadPublishRules(join(import.meta.dir, '../.github/workflows/ci.yml'))).toThrow(
      'Publish tarballs',
    );
  });
});

describe('publishProblems', () => {
  test('accepts what a package ships', () => {
    expect(
      check({ publishConfig: { access: 'public' }, scripts: { test: 'bun test' } }, [
        ...shipped,
        ...files('package/LICENSE-MIT', 'package/LICENSE-APACHE', 'package/dist/sub/a.d.ts'),
        { type: 'd', name: 'package/dist/' },
      ]),
    ).toEqual([]);
  });

  test.each([
    'package/src/index.ts',
    'package/.npmrc',
    'package/install.js',
    'package/dist/.hidden.js',
    'package/README.md.bak',
    'other/package.json',
  ])('rejects unexpected entry %p', (entry) => {
    expect(check({}, [...shipped, ...files(entry)])).toEqual([`unexpected entry: - ${entry}`]);
  });

  test('rejects a symlink, a duplicate entry and a missing manifest', () => {
    expect(check({}, [...shipped, { type: 'l', name: 'package/dist/x.js' }])).toEqual([
      'unexpected entry: l package/dist/x.js',
    ]);
    expect(check({}, [...shipped, ...files('package/package.json')])).toEqual([
      'duplicate entries: package/package.json',
    ]);
    expect(check({}, files('package/README.md'))).toEqual(['no package/package.json']);
  });

  test.each([
    [{ publishConfig: { registry: 'https://evil.example/' } }, 'publishConfig may only set access'],
    [{ publishConfig: 'x' }, 'publishConfig may only set access'],
    [{ scripts: { preinstall: 'x' } }, 'lifecycle scripts'],
    [{ scripts: { install: 'x' } }, 'lifecycle scripts'],
    [{ scripts: { postinstall: 'x' } }, 'lifecycle scripts'],
    [{ scripts: { prepare: 'x' } }, 'lifecycle scripts'],
    [{ scripts: { prepublishOnly: 'x' } }, 'lifecycle scripts'],
    [{ scripts: { publish: 'x' } }, 'lifecycle scripts'],
    [{ scripts: { prepack: 'x' } }, 'lifecycle scripts'],
    [{ scripts: { postpack: 'x' } }, 'lifecycle scripts'],
    [{ scripts: 'x' }, 'lifecycle scripts'],
    [{ bundleDependencies: ['x'] }, 'bundled dependencies'],
    [{ bundledDependencies: true }, 'bundled dependencies'],
    [{ bin: { x: 'dist/index.js' } }, 'may not declare bin, directories or man'],
    [{ bin: 'dist/index.js' }, 'may not declare bin, directories or man'],
    [{ directories: { lib: 'dist' } }, 'may not declare bin, directories or man'],
    [{ man: './dist/x.1' }, 'may not declare bin, directories or man'],
  ])('rejects %j', (manifest, message) => {
    const problems = check(manifest);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(message);
  });

  test('accepts the dependencies a package is allowed', () => {
    expect(
      publishProblems(
        {
          name: '@knead-js/graphql',
          dependencies: { dataloader: '2.2.3', '@leaven-graphql/core': '0.2.2' },
          peerDependencies: { graphql: '^16', '@knead-js/core': '1.2.3' },
        },
        shipped,
        rules,
      ),
    ).toEqual([]);
  });

  test.each([
    ['dependencies', 'left-pad'],
    ['optionalDependencies', 'left-pad'],
    ['peerDependencies', 'left-pad'],
    // Allowed for @knead-js/graphql, not for @knead-js/core.
    ['dependencies', 'dataloader'],
  ])('rejects %s %p on @knead-js/core', (field, dep) => {
    expect(check({ [field]: { [dep]: '1.0.0' } })).toEqual([
      `dependency ${dep} is not allowed (see ALLOWED_DEPENDENCIES)`,
    ]);
  });

  test.each(['7.0.2', '^7', '~1.2', '1.x', '*', '>=1 <2', '^16 || ^17', '1.0.0 - 2.0.0'])(
    'accepts the registry specifier %j',
    (spec) => {
      expect(
        publishProblems(
          { name: '@knead-js/casl', dependencies: { '@casl/ability': spec } },
          shipped,
          rules,
        ),
      ).toEqual([]);
    },
  );

  test.each([
    'npm:evil@1.0.0',
    'git+https://github.com/evil/casl.git',
    'github:evil/casl',
    'https://example.com/casl-7.0.2.tgz',
    'file:../casl',
    'link:../casl',
    'workspace:^',
    'latest',
    '7.0.2#main',
    '',
  ])('rejects the non-registry specifier %j', (spec) => {
    expect(
      publishProblems(
        { name: '@knead-js/casl', dependencies: { '@casl/ability': spec } },
        shipped,
        rules,
      ),
    ).toEqual(['dependency @casl/ability has a non-registry specifier']);
  });

  // About 0.2 s each at this size when idle; a quadratic regex would take minutes. Each input is
  // timed on its own, with headroom for a loaded machine (as the publish step's jq test does).
  test.each([
    ['range', `${'1 '.repeat(100_000)}:`],
    ['range', `1.0.0-${'a.'.repeat(100_000)}:`],
    ['range', `${'^1 || '.repeat(50_000)}:`],
    ['range', `${'1 - '.repeat(50_000)}:`],
    ['entry', `- package/dist/${'a/'.repeat(100_000)}`],
    ['entry', `- package/dist/${'a.'.repeat(100_000)}/`],
  ] as const)('rejects a pathological %s in linear time', (kind, input) => {
    const start = performance.now();
    expect(rules[kind].test(input)).toBe(false);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

describe('parseAllowedDependencies', () => {
  test('a package listed twice is allowed nothing, as in the publish step', () => {
    const allowed = parseAllowedDependencies('@knead-js/a: x y\n@knead-js/b:\n@knead-js/a: z\n');
    expect(allowed.get('@knead-js/a')).toEqual(new Set());
    expect(allowed.get('@knead-js/b')).toEqual(new Set());
  });
});

describe('exportTargets', () => {
  test('lists every file of every subpath, once', () => {
    expect(
      exportTargets({
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './http': { types: './dist/http/index.d.ts', default: './dist/http/index.js' },
        './x': './dist/index.js',
      }),
    ).toEqual(['dist/index.d.ts', 'dist/index.js', 'dist/http/index.d.ts', 'dist/http/index.js']);
  });
});
