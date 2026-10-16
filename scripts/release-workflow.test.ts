// Runs the publish step of .github/workflows/release.yml against fake tarballs with a fake `npm`
// on PATH, so the shell logic the publish job runs is tested without touching the registry.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}
const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, '../.github/workflows/release.yml'), 'utf8'),
) as { jobs: Record<string, { steps: Step[] }> };
const step = workflow.jobs.publish?.steps.find((s) => s.name === 'Publish tarballs');
const publishStep = step?.run;
// The step's literal env (ALLOWED_PACKAGES); expressions such as SUMS_SHA256 are set per test.
const stepEnv = Object.fromEntries(
  Object.entries(step?.env ?? {}).filter(([, v]) => !String(v).includes('${{')),
);

const REGISTRY_FLAGS = '--registry=https://registry.npmjs.org/ --loglevel=notice';

// view <name>@<version> version: prints the version for specs in FAKE_EXISTING.
// view <name> dist-tags.latest: prints the version from FAKE_LATEST ("name=version ...").
// Otherwise fails with FAKE_VIEW_ERROR (default E404).
const fakeNpm = `#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_LOG"
case "$1" in
  view)
    if [ "$3" = dist-tags.latest ]; then
      for entry in $FAKE_LATEST; do
        if [ "\${entry%=*}" = "$2" ]; then echo "\${entry#*=}"; exit 0; fi
      done
    elif [[ " $FAKE_EXISTING " == *" $2 "* ]]; then
      echo "\${2##*@}"; exit 0
    fi
    echo "npm error code \${FAKE_VIEW_ERROR:-E404}" >&2; exit 1 ;;
  publish) exit 0 ;;
esac
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sh(cmd: string[], cwd?: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

interface FakePackage {
  name: string;
  version: string;
  /** Extra manifest fields. */
  manifest?: Record<string, unknown>;
  /** Extra regular files, path relative to the tarball root (e.g. `package/dist/x.js`). */
  files?: string[];
  /** Symlinks to add: [entry, target]. */
  symlinks?: [string, string][];
  /** Append a second package/package.json with these contents. */
  duplicateManifest?: Record<string, unknown>;
  /** Tarball file name (default: the npm-style name). */
  file?: string;
}

interface PublishOptions {
  env?: Record<string, string>;
  /** Rewrites SHA256SUMS after it is generated (its digest is taken before the rewrite). */
  tamperSums?: (sums: string) => string;
  /** Hand over the digest of the rewritten SHA256SUMS, as if the build job had been subverted. */
  digestAfterTamper?: boolean;
  /** Overrides the digest handed to the step as SUMS_SHA256. */
  sumsDigest?: string;
  /** Skip writing SHA256SUMS. */
  noSums?: boolean;
  /** Extra tarballs added after SHA256SUMS is written. */
  unlisted?: FakePackage[];
}

const tarballName = (name: string, version: string) =>
  `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;

function makeTarball(tmp: string, out: string, pkg: FakePackage): string {
  const src = mkdtempSync(join(tmp, 'src-'));
  const write = (entry: string, content: string) => {
    mkdirSync(dirname(join(src, entry)), { recursive: true });
    writeFileSync(join(src, entry), content);
  };
  write(
    'package/package.json',
    JSON.stringify({ name: pkg.name, version: pkg.version, ...pkg.manifest }),
  );
  write('package/README.md', '# readme');
  write('package/dist/index.js', 'export {};');
  const entries = ['package/package.json', 'package/README.md', 'package/dist/index.js'];
  for (const f of pkg.files ?? []) {
    write(f, 'x');
    entries.push(f);
  }
  for (const [entry, target] of pkg.symlinks ?? []) {
    mkdirSync(dirname(join(src, entry)), { recursive: true });
    symlinkSync(target, join(src, entry));
    entries.push(entry);
  }
  const tar = join(src, 'out.tar');
  sh(['tar', '-cf', tar, '-C', src, ...entries]);
  if (pkg.duplicateManifest) {
    const dup = mkdtempSync(join(tmp, 'dup-'));
    mkdirSync(join(dup, 'package'));
    writeFileSync(join(dup, 'package', 'package.json'), JSON.stringify(pkg.duplicateManifest));
    sh(['tar', '-rf', tar, '-C', dup, 'package/package.json']);
  }
  const file = pkg.file ?? tarballName(pkg.name, pkg.version);
  writeFileSync(join(out, file), Bun.gzipSync(readFileSync(tar)));
  return file;
}

function publish(
  tag: string,
  packages: (FakePackage | [string, string])[],
  opts: PublishOptions = {},
) {
  const tmp = mkdtempSync(join(tmpdir(), 'hpmws-publish-test-'));
  dirs.push(tmp);
  const bin = join(tmp, 'bin');
  const tarballs = join(tmp, 'npm-tarballs');
  mkdirSync(bin);
  mkdirSync(tarballs);
  writeFileSync(join(bin, 'npm'), fakeNpm);
  chmodSync(join(bin, 'npm'), 0o755);
  for (const p of packages) {
    makeTarball(tmp, tarballs, Array.isArray(p) ? { name: p[0], version: p[1] } : p);
  }
  let digest = '';
  if (!opts.noSums) {
    const sums = sh(['bash', '-c', 'sha256sum -- *.tgz'], tarballs);
    writeFileSync(join(tarballs, 'SHA256SUMS'), sums);
    digest = new Bun.CryptoHasher('sha256').update(sums).digest('hex');
    if (opts.tamperSums) {
      const tampered = opts.tamperSums(sums);
      writeFileSync(join(tarballs, 'SHA256SUMS'), tampered);
      if (opts.digestAfterTamper)
        digest = new Bun.CryptoHasher('sha256').update(tampered).digest('hex');
    }
  }
  for (const p of opts.unlisted ?? []) makeTarball(tmp, tarballs, p);
  const log = join(tmp, 'npm.log');
  writeFileSync(log, '');
  const r = Bun.spawnSync(['bash', '-e', '-c', publishStep as string], {
    cwd: tarballs,
    env: {
      ...process.env,
      ...stepEnv,
      SUMS_SHA256: opts.sumsDigest ?? digest,
      ...opts.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: log,
      RUNNER_TEMP: tmp,
      GITHUB_REF_NAME: tag,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    exitCode: r.exitCode,
    output: r.stdout.toString() + r.stderr.toString(),
    calls,
    publishes: calls.filter((c) => c.startsWith('npm publish')),
  };
}

const publishCmd = (file: string, tag: string) =>
  `npm publish ./${file} --access public --tag ${tag} --ignore-scripts ${REGISTRY_FLAGS}`;

function expectRejected(r: ReturnType<typeof publish>, message: string) {
  expect(r.exitCode).not.toBe(0);
  expect(r.publishes).toEqual([]);
  expect(r.output).toContain(message);
}

describe('release.yml publish step', () => {
  test('exists and declares the package allowlist', () => {
    expect(typeof publishStep).toBe('string');
    expect(stepEnv.ALLOWED_PACKAGES).toContain('@hpmws/core');
  });

  test('publishes stable versions to latest without running scripts, against npmjs.org', () => {
    const r = publish('v1.2.3', [['@hpmws/core', '1.2.3']]);
    expect(r.exitCode).toBe(0);
    expect(r.publishes).toEqual([publishCmd('hpmws-core-1.2.3.tgz', 'latest')]);
    // Every npm call names the registry explicitly.
    expect(r.calls.length).toBeGreaterThan(1);
    for (const c of r.calls) expect(c.endsWith(REGISTRY_FLAGS)).toBe(true);
  });

  test.each([
    ['1.0.0-next.2', 'next'],
    ['1.0.0-rc.1', 'rc'],
    ['1.0.0-beta', 'beta'],
    ['1.0.0-0', 'next'],
    ['1.0.0-1', 'next'],
    ['1.0.0-0.3', 'next'],
    ['1.0.0-2beta.1', 'next'],
    ['1.0.0-x', 'next'],
    ['1.0.0-X.1', 'next'],
    ['1.0.0-v1', 'next'],
    ['1.0.0-V2.beta', 'next'],
    ['1.0.0-xyz.1', 'xyz'],
    ['1.0.0-vnext.1', 'vnext'],
  ])('prerelease %s publishes to dist-tag %s', (version, distTag) => {
    const r = publish(`v${version}`, [['@hpmws/core', version]]);
    expect(r.exitCode).toBe(0);
    expect(r.publishes).toEqual([publishCmd(`hpmws-core-${version}.tgz`, distTag)]);
  });

  describe('stable dist-tag', () => {
    test.each([
      ['1.2.3', '1.2.2', 'latest'],
      ['1.2.3', '1.1.9', 'latest'],
      ['2.0.0', '1.9.9', 'latest'],
      ['1.10.0', '1.9.0', 'latest'],
      ['1.2.10', '1.2.9', 'latest'],
      ['1.2.3', '1.2.3-rc.1', 'latest'],
      ['1.2.3', '1.2.3-rc.1+build.5', 'latest'],
      ['1.2.3', '2.0.0', 'v1.2-latest'],
      ['1.2.3', '1.3.0', 'v1.2-latest'],
      ['1.2.3', '1.2.4', 'v1.2-latest'],
      ['1.9.0', '1.10.0', 'v1.9-latest'],
      ['1.2.3', '1.2.3', 'v1.2-latest'],
      ['1.2.3', '1.2.4-rc.1', 'v1.2-latest'],
    ])('%s with latest at %s publishes to %s', (version, current, distTag) => {
      const r = publish(`v${version}`, [['@hpmws/core', version]], {
        env: { FAKE_LATEST: `@hpmws/core=${current}` },
      });
      expect(r.exitCode).toBe(0);
      expect(r.publishes).toEqual([publishCmd(`hpmws-core-${version}.tgz`, distTag)]);
    });

    test('a package that is not on npm yet takes latest', () => {
      const r = publish('v0.1.0', [['@hpmws/core', '0.1.0']]);
      expect(r.exitCode).toBe(0);
      expect(r.publishes).toEqual([publishCmd('hpmws-core-0.1.0.tgz', 'latest')]);
    });

    test('a garbled latest dist-tag stops the release', () => {
      const r = publish('v1.2.3', [['@hpmws/core', '1.2.3']], {
        env: { FAKE_LATEST: '@hpmws/core=not-a-version' },
      });
      expectRejected(r, 'unexpected latest dist-tag');
    });
  });

  test('skips versions already on npm', () => {
    const r = publish(
      'v1.2.3',
      [
        ['@hpmws/core', '1.2.3'],
        ['@hpmws/http', '1.2.3'],
      ],
      { env: { FAKE_EXISTING: '@hpmws/core@1.2.3' } },
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('skip @hpmws/core@1.2.3');
    expect(r.publishes).toEqual([publishCmd('hpmws-http-1.2.3.tgz', 'latest')]);
  });

  test('publishes nothing when any tarball does not match the tag', () => {
    const r = publish('v1.2.3', [
      ['@hpmws/core', '1.2.3'],
      ['@hpmws/http', '1.2.2'],
    ]);
    expectRejected(r, 'is at 1.2.2');
  });

  test('stops when npm cannot be queried', () => {
    const r = publish('v1.2.3', [['@hpmws/core', '1.2.3']], {
      env: { FAKE_VIEW_ERROR: 'ETIMEDOUT' },
    });
    expectRejected(r, 'could not query npm');
  });

  describe('package allowlist', () => {
    test.each(['evil', '@hpmws/evil', '@hpmws/core-evil', '@hpmws/cor', '@HPMWS/core'])(
      'publishes nothing for %p',
      (name) => {
        const r = publish('v1.2.3', [
          ['@hpmws/core', '1.2.3'],
          { name, version: '1.2.3', file: 'zz-evil-1.2.3.tgz' },
        ]);
        expectRejected(r, `unexpected package ${name}`);
      },
    );

    test('publishes nothing when the tarball name does not match its manifest', () => {
      const r = publish('v1.2.3', [
        { name: '@hpmws/http', version: '1.2.3', file: 'hpmws-core-1.2.3.tgz' },
      ]);
      expectRejected(r, 'expected file hpmws-http-1.2.3.tgz');
    });
  });

  describe('SHA256SUMS', () => {
    test('is required', () => {
      expectRejected(
        publish('v1.2.3', [['@hpmws/core', '1.2.3']], { noSums: true, sumsDigest: 'a'.repeat(64) }),
        'SHA256SUMS is missing',
      );
    });

    test('must match the digest reported by the build job', () => {
      const r = publish('v1.2.3', [['@hpmws/core', '1.2.3']], { sumsDigest: '0'.repeat(64) });
      expectRejected(r, 'does not match the digest');
    });

    test('a missing build-job digest stops the release', () => {
      const r = publish('v1.2.3', [['@hpmws/core', '1.2.3']], { sumsDigest: '' });
      expectRejected(r, 'no SHA256SUMS digest');
    });

    test('rejects SHA256SUMS edited after the build job reported its digest', () => {
      const r = publish('v1.2.3', [['@hpmws/core', '1.2.3']], {
        tamperSums: (s) => `${'f'.repeat(64)}${s.slice(64)}`,
      });
      expectRejected(r, 'does not match the digest');
    });

    test('rejects a tarball whose checksum does not match even when the digest is consistent', () => {
      const r = publishWithConsistentDigest(
        'v1.2.3',
        [['@hpmws/core', '1.2.3']],
        (s) => `${'f'.repeat(64)}${s.slice(64)}`,
      );
      expectRejected(r, 'does not match SHA256SUMS');
    });

    test('rejects a malformed line', () => {
      const r = publishWithConsistentDigest('v1.2.3', [['@hpmws/core', '1.2.3']], (s) =>
        s.replace('  hpmws-core', '  ../hpmws-core'),
      );
      expectRejected(r, 'malformed line');
    });

    test('rejects a tarball that SHA256SUMS does not list', () => {
      const r = publish('v1.2.3', [['@hpmws/core', '1.2.3']], {
        unlisted: [{ name: '@hpmws/http', version: '1.2.3' }],
      });
      expectRejected(r, 'differ from those listed');
    });

    test('rejects a listed tarball that is missing', () => {
      const r = publishWithConsistentDigest(
        'v1.2.3',
        [['@hpmws/core', '1.2.3']],
        (s) => `${s}${'a'.repeat(64)}  hpmws-http-1.2.3.tgz\n`,
      );
      expectRejected(r, 'differ from those listed');
    });

    test('rejects a duplicated line', () => {
      const r = publishWithConsistentDigest('v1.2.3', [['@hpmws/core', '1.2.3']], (s) => s + s);
      expectRejected(r, 'differ from those listed');
    });
  });

  describe('tarball contents', () => {
    test('accepts the files a package ships, including LICENSE files and nested dist', () => {
      const r = publish('v1.2.3', [
        {
          name: '@hpmws/core',
          version: '1.2.3',
          files: ['package/LICENSE-MIT', 'package/LICENSE-APACHE', 'package/dist/sub/a.d.ts'],
        },
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.publishes).toHaveLength(1);
    });

    test('rejects a second package/package.json', () => {
      const r = publish('v1.2.3', [
        {
          name: '@hpmws/core',
          version: '1.2.3',
          duplicateManifest: {
            name: '@hpmws/core',
            version: '1.2.3',
            scripts: { postinstall: 'x' },
          },
        },
      ]);
      expectRejected(r, 'duplicate entries: package/package.json');
    });

    test.each([
      'package/src/index.ts',
      'package/.npmrc',
      'package/install.js',
      'package/dist/.hidden.js',
      'package/README.md.bak',
      'other/package.json',
    ])('rejects unexpected entry %p', (entry) => {
      const r = publish('v1.2.3', [{ name: '@hpmws/core', version: '1.2.3', files: [entry] }]);
      expectRejected(r, `unexpected entries: - ${entry}`);
    });

    test('rejects a symlink, even inside dist', () => {
      const r = publish('v1.2.3', [
        { name: '@hpmws/core', version: '1.2.3', symlinks: [['package/dist/x.js', '/etc/passwd']] },
      ]);
      expectRejected(r, 'unexpected entries: l package/dist/x.js');
    });
  });

  describe('manifest', () => {
    test.each([
      [
        { publishConfig: { registry: 'https://evil.example/' } },
        'publishConfig may only set access',
      ],
      [
        { publishConfig: { '@hpmws:registry': 'https://evil.example/' } },
        'publishConfig may only set access',
      ],
      [{ publishConfig: 'x' }, 'publishConfig may only set access'],
      [{ scripts: { preinstall: 'x' } }, 'lifecycle scripts'],
      [{ scripts: { install: 'x' } }, 'lifecycle scripts'],
      [{ scripts: { postinstall: 'x' } }, 'lifecycle scripts'],
      [{ scripts: { prepare: 'x' } }, 'lifecycle scripts'],
      [{ scripts: { prepublishOnly: 'x' } }, 'lifecycle scripts'],
      [{ scripts: { publish: 'x' } }, 'lifecycle scripts'],
      [{ scripts: { postpack: 'x' } }, 'lifecycle scripts'],
      [{ scripts: 'x' }, 'lifecycle scripts'],
      [{ bundleDependencies: ['x'] }, 'bundled dependencies'],
      [{ bundledDependencies: true }, 'bundled dependencies'],
      [{ name: 42 }, 'invalid package.json'],
    ])('rejects %j', (manifest, message) => {
      const r = publish('v1.2.3', [
        { name: '@hpmws/core', version: '1.2.3', manifest: manifest as Record<string, unknown> },
      ]);
      expectRejected(r, message);
    });

    test('accepts publishConfig.access and ordinary scripts', () => {
      const r = publish('v1.2.3', [
        {
          name: '@hpmws/core',
          version: '1.2.3',
          manifest: { publishConfig: { access: 'public' }, scripts: { test: 'bun test' } },
        },
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.publishes).toHaveLength(1);
    });
  });
});

/** Like publish(), but SUMS_SHA256 is the digest of the rewritten SHA256SUMS. */
function publishWithConsistentDigest(
  tag: string,
  packages: (FakePackage | [string, string])[],
  rewrite: (sums: string) => string,
) {
  return publish(tag, packages, { tamperSums: rewrite, digestAfterTamper: true });
}
