// Runs the publish step of .github/workflows/release.yml against fake tarballs with a fake `npm`
// on PATH, so the shell logic the publish job runs is tested without touching the registry.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Every test here runs the real publish step: bash, GNU tar over every allowed tarball and a node
// process loading pacote. That normally takes 0.3-1 s, but under load (for example `pnpm test`
// next to another `bun test scripts`) it exceeded bun's 5 s default and failed spuriously.
setDefaultTimeout(60_000);

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

const REGISTRY_FLAGS =
  '--registry=https://registry.npmjs.org/ --@knead-js:registry=https://registry.npmjs.org/ --loglevel=notice';

// view <name> name: prints the name unless it is in FAKE_MISSING (E404) or FAKE_PREFLIGHT_ERROR is set.
// view <name>@<version> version: prints the version for specs in FAKE_EXISTING.
// view <name> dist-tags.latest: prints the version from FAKE_LATEST ("name=version ...").
// Otherwise fails with FAKE_VIEW_ERROR (default E404).
// publish <path>: fails for tarballs named in FAKE_PUBLISH_ERROR ("file=code ..."); code
// `conflict` prints npm's "previously published versions" error, any other code is printed as is.
const fakeNpm = `#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_LOG"
pwd >> "$FAKE_CWD_LOG"
case "$1" in
  view)
    if [ "$3" = name ]; then
      if [ -n "\${FAKE_PREFLIGHT_ERROR:-}" ]; then echo "npm error code $FAKE_PREFLIGHT_ERROR" >&2; exit 1; fi
      if [[ " \${FAKE_MISSING:-} " == *" $2 "* ]]; then echo "npm error code E404" >&2; exit 1; fi
      echo "$2"; exit 0
    elif [ "$3" = dist-tags.latest ]; then
      for entry in $FAKE_LATEST; do
        if [ "\${entry%=*}" = "$2" ]; then echo "\${entry#*=}"; exit 0; fi
      done
    elif [[ " $FAKE_EXISTING " == *" $2 "* ]]; then
      echo "\${2##*@}"; exit 0
    fi
    echo "npm error code \${FAKE_VIEW_ERROR:-E404}" >&2; exit 1 ;;
  publish)
    for entry in \${FAKE_PUBLISH_ERROR:-}; do
      if [ "\${2##*/}" = "\${entry%=*}" ]; then
        if [ "\${entry#*=}" = conflict ]; then
          echo "npm error 403 403 Forbidden - PUT https://registry.npmjs.org/x - You cannot publish over the previously published versions: 1.2.3." >&2
        else
          echo "npm error code \${entry#*=}" >&2
        fi
        exit 1
      fi
    done
    exit 0 ;;
  # The publish step loads node-tar and pacote from the real npm's global root.
  root) exec "$REAL_NPM" "$@" ;;
esac
`;
const REAL_NPM = Bun.which('npm');

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
  /** Extra regular files with the given contents: [entry, contents]. */
  blobs?: [string, Buffer][];
  /** Symlinks to add: [entry, target]. */
  symlinks?: [string, string][];
  /** Append a second package/package.json with these contents. */
  duplicateManifest?: Record<string, unknown>;
  /** Tarball file name (default: the npm-style name). */
  file?: string;
  /** Uncompressed tar bytes to use instead of building the tarball with GNU tar. */
  raw?: Buffer;
}

// A minimal tar writer, for tarballs GNU tar would never produce (PAX/GNU sparse tricks).
interface RawEntry {
  name: string;
  data?: string | Buffer;
  /** Typeflag (default '0', a regular file). */
  type?: string;
  /** PAX extended header records, written as a preceding 'x' entry. */
  pax?: Record<string, string>;
}

function rawHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.fill(' ', 148, 156);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

const padBlock = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

function paxData(records: Record<string, string>): Buffer {
  let out = '';
  for (const [k, v] of Object.entries(records)) {
    const body = ` ${k}=${v}\n`;
    let len = body.length + 1;
    while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
    out += `${len}${body}`;
  }
  return Buffer.from(out, 'utf8');
}

function rawTar(entries: RawEntry[], trailer: Buffer = Buffer.alloc(0)): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (e.pax) {
      const pax = paxData(e.pax);
      parts.push(rawHeader('././@PaxHeader', pax.length, 'x'), padBlock(pax));
    }
    const data = Buffer.from(e.data ?? '');
    parts.push(rawHeader(e.name, data.length, e.type ?? '0'), padBlock(data));
  }
  parts.push(Buffer.alloc(1024), trailer);
  return Buffer.concat(parts);
}

/**
 * The reviewer's PoC: PAX `GNU.sparse.name` swaps two entries for GNU tar only. GNU tar sees a
 * clean package/package.json, while node-tar (and so pacote and npm publish) reads one with a
 * postinstall script.
 */
function sparseNameSwap(name: string, version: string): Buffer {
  const benign = JSON.stringify({ name, version, description: 'test' });
  const evil = JSON.stringify({
    name,
    version,
    description: 'test',
    scripts: { postinstall: 'node -e "1"' },
  });
  const sparse = (path: string, sparseName: string, data: string): RawEntry => ({
    name: path,
    data,
    pax: {
      path,
      'GNU.sparse.name': sparseName,
      'GNU.sparse.size': String(data.length),
      'GNU.sparse.numblocks': '1',
      'GNU.sparse.map': `0,${data.length}`,
    },
  });
  return rawTar([
    { name: 'package/README.md', data: '# readme' },
    { name: 'package/dist/index.js', data: 'export {};' },
    sparse('package/package.json', 'package/dist/a.js', evil),
    sparse('package/dist/b.js', 'package/package.json', benign),
  ]);
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
  /**
   * Only the given packages. By default every other allowed package is added at the tag's
   * version, since the step refuses a partial set.
   */
  partial?: boolean;
  /** Extra files planted in the artifact directory after SHA256SUMS is written: [name, contents]. */
  stray?: [string, string][];
}

const ALLOWED = String(stepEnv.ALLOWED_PACKAGES ?? '')
  .split(/\s+/)
  .filter(Boolean);

const tarballName = (name: string, version: string) =>
  `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;

function makeTarball(tmp: string, out: string, pkg: FakePackage): string {
  if (pkg.raw) {
    const file = pkg.file ?? tarballName(pkg.name, pkg.version);
    writeFileSync(join(out, file), Bun.gzipSync(new Uint8Array(pkg.raw)));
    return file;
  }
  const src = mkdtempSync(join(tmp, 'src-'));
  const write = (entry: string, content: string) => {
    mkdirSync(dirname(join(src, entry)), { recursive: true });
    writeFileSync(join(src, entry), content);
  };
  write(
    'package/package.json',
    JSON.stringify({ name: pkg.name, version: pkg.version, description: 'test', ...pkg.manifest }),
  );
  write('package/README.md', '# readme');
  write('package/dist/index.js', 'export {};');
  const entries = ['package/package.json', 'package/README.md', 'package/dist/index.js'];
  for (const f of pkg.files ?? []) {
    write(f, 'x');
    entries.push(f);
  }
  for (const [entry, contents] of pkg.blobs ?? []) {
    mkdirSync(dirname(join(src, entry)), { recursive: true });
    writeFileSync(join(src, entry), contents);
    entries.push(entry);
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
  const tmp = mkdtempSync(join(tmpdir(), 'knead-publish-test-'));
  dirs.push(tmp);
  const bin = join(tmp, 'bin');
  const tarballs = join(tmp, 'npm-tarballs');
  mkdirSync(bin);
  mkdirSync(tarballs);
  writeFileSync(join(bin, 'npm'), fakeNpm);
  chmodSync(join(bin, 'npm'), 0o755);
  const given = packages.map((p) => (Array.isArray(p) ? { name: p[0], version: p[1] } : p));
  const explicit = given.map((p) => makeTarball(tmp, tarballs, p));
  if (!opts.partial) {
    const version = tag.replace(/^refs\/tags\//, '').replace(/^v/, '');
    const taken = new Set([
      ...explicit,
      ...(opts.unlisted ?? []).map((p) => p.file ?? tarballName(p.name, p.version)),
    ]);
    const named = new Set([...given, ...(opts.unlisted ?? [])].map((p) => p.name));
    for (const name of ALLOWED) {
      if (named.has(name) || taken.has(tarballName(name, version))) continue;
      makeTarball(tmp, tarballs, { name, version });
    }
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
  for (const [name, contents] of opts.stray ?? []) writeFileSync(join(tarballs, name), contents);
  const log = join(tmp, 'npm.log');
  const cwdLog = join(tmp, 'npm-cwd.log');
  writeFileSync(log, '');
  writeFileSync(cwdLog, '');
  const r = Bun.spawnSync(['bash', '-e', '-c', publishStep as string], {
    cwd: tarballs,
    env: {
      ...process.env,
      ...stepEnv,
      SUMS_SHA256: opts.sumsDigest ?? digest,
      ...opts.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_CWD_LOG: cwdLog,
      REAL_NPM: REAL_NPM ?? 'npm-not-found',
      RUNNER_TEMP: tmp,
      GITHUB_REF_NAME: tag,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const rawCalls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  // Tarballs are published by absolute path; show them relative to keep expectations short.
  const calls = rawCalls.map((c) => c.replaceAll(`${tarballs}/`, './'));
  return {
    exitCode: r.exitCode,
    tarballs,
    rawCalls,
    cwds: readFileSync(cwdLog, 'utf8').split('\n').filter(Boolean),
    output: r.stdout.toString() + r.stderr.toString(),
    calls,
    /** Publishes of the packages the test passed in. */
    publishes: calls.filter(
      (c) => c.startsWith('npm publish') && explicit.some((f) => c.includes(` ./${f} `)),
    ),
    /** Every publish, including the packages added to complete the set. */
    allPublishes: calls.filter((c) => c.startsWith('npm publish')),
  };
}

const publishCmd = (file: string, tag: string) =>
  `npm publish ./${file} --access public --tag ${tag} --ignore-scripts ${REGISTRY_FLAGS}`;

function expectRejected(r: ReturnType<typeof publish>, message: string) {
  expect(r.exitCode).not.toBe(0);
  expect(r.allPublishes).toEqual([]);
  expect(r.output).toContain(message);
}

describe('release.yml publish step', () => {
  test('exists and declares the package allowlist', () => {
    expect(typeof publishStep).toBe('string');
    expect(stepEnv.ALLOWED_PACKAGES).toContain('@knead-js/core');
  });

  test('publishes stable versions to latest without running scripts, against npmjs.org', () => {
    const r = publish('v1.2.3', [['@knead-js/core', '1.2.3']]);
    expect(r.exitCode).toBe(0);
    expect(r.publishes).toEqual([publishCmd('knead-js-core-1.2.3.tgz', 'latest')]);
    // Every npm call names the registry explicitly.
    expect(r.calls.length).toBeGreaterThan(1);
    for (const c of r.calls.filter((c) => c !== 'npm root -g'))
      expect(c.endsWith(REGISTRY_FLAGS)).toBe(true);
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
    const r = publish(`v${version}`, [['@knead-js/core', version]]);
    expect(r.exitCode).toBe(0);
    expect(r.publishes).toEqual([publishCmd(`knead-js-core-${version}.tgz`, distTag)]);
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
      const r = publish(`v${version}`, [['@knead-js/core', version]], {
        env: { FAKE_LATEST: `@knead-js/core=${current}` },
      });
      expect(r.exitCode).toBe(0);
      expect(r.publishes).toEqual([publishCmd(`knead-js-core-${version}.tgz`, distTag)]);
    });

    test('a package without a latest dist-tag takes latest', () => {
      const r = publish('v0.1.0', [['@knead-js/core', '0.1.0']]);
      expect(r.exitCode).toBe(0);
      expect(r.publishes).toEqual([publishCmd('knead-js-core-0.1.0.tgz', 'latest')]);
    });

    // core is not the first tarball, so this proves every dist-tag is resolved before any publish.
    test('a garbled latest dist-tag stops the release before anything is published', () => {
      const r = publish('v1.2.3', [['@knead-js/core', '1.2.3']], {
        env: { FAKE_LATEST: '@knead-js/core=not-a-version' },
      });
      expectRejected(r, 'unexpected latest dist-tag');
    });
  });

  test('skips versions already on npm', () => {
    const r = publish(
      'v1.2.3',
      [
        ['@knead-js/core', '1.2.3'],
        ['@knead-js/http', '1.2.3'],
      ],
      { env: { FAKE_EXISTING: '@knead-js/core@1.2.3' } },
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('skip @knead-js/core@1.2.3');
    expect(r.publishes).toEqual([publishCmd('knead-js-http-1.2.3.tgz', 'latest')]);
  });

  describe('publish errors', () => {
    test('a version published concurrently is skipped and the rest are still published', () => {
      const r = publish('v1.2.3', [['@knead-js/core', '1.2.3']], {
        env: { FAKE_PUBLISH_ERROR: 'knead-js-core-1.2.3.tgz=conflict' },
      });
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('skip @knead-js/core@1.2.3 (published concurrently)');
      // core was attempted, and every other package was published after it.
      expect(r.allPublishes).toContain(publishCmd('knead-js-core-1.2.3.tgz', 'latest'));
      expect(r.allPublishes).toHaveLength(ALLOWED.length);
      expect(r.allPublishes.at(-1)).toBe(publishCmd('knead-js-testing-1.2.3.tgz', 'latest'));
    });

    test('any other publish error stops the run, after the packages already published', () => {
      const r = publish('v1.2.3', [['@knead-js/http', '1.2.3']], {
        env: { FAKE_PUBLISH_ERROR: 'knead-js-http-1.2.3.tgz=E500' },
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain('npm error code E500');
      expect(r.output).not.toContain('published concurrently');
      const files = r.allPublishes.map((c) => c.split(' ')[2]);
      const failed = files.indexOf('./knead-js-http-1.2.3.tgz');
      // Packages before http were published; http was the last attempt.
      expect(failed).toBeGreaterThan(0);
      expect(failed).toBe(files.length - 1);
      expect(files).toContain('./knead-js-core-1.2.3.tgz');
      expect(files).not.toContain('./knead-js-testing-1.2.3.tgz');
    });
  });

  test('publishes nothing when any tarball does not match the tag', () => {
    const r = publish('v1.2.3', [
      ['@knead-js/core', '1.2.3'],
      ['@knead-js/http', '1.2.2'],
    ]);
    expectRejected(r, 'is at 1.2.2');
  });

  test('stops when npm cannot be queried', () => {
    const r = publish('v1.2.3', [['@knead-js/core', '1.2.3']], {
      env: { FAKE_VIEW_ERROR: 'ETIMEDOUT' },
    });
    expectRejected(r, 'could not query npm');
  });

  describe('artifact directory and npm working directory', () => {
    test.each([
      ['.npmrc', '@knead-js:registry=https://evil.example/\n'],
      ['notes.txt', 'x'],
      ['.hidden.tgz', 'x'],
    ])('rejects a planted %p', (name, contents) => {
      const r = publish('v1.2.3', [], { stray: [[name, contents]] });
      expectRejected(r, `unexpected file in the artifact: ${name}`);
    });

    test('runs npm from an empty directory with absolute tarball paths and the scoped registry', () => {
      const r = publish('v1.2.3', []);
      expect(r.exitCode).toBe(0);
      expect(new Set(r.cwds).size).toBe(1);
      expect(r.cwds[0]).not.toBe(r.tarballs);
      expect(readdirSync(r.cwds[0])).toEqual([]);
      const published = r.rawCalls.filter((c) => c.startsWith('npm publish'));
      expect(published).toHaveLength(ALLOWED.length);
      for (const c of published) expect(c.split(' ')[2].startsWith(`${r.tarballs}/`)).toBe(true);
      for (const c of r.rawCalls.filter((c) => c !== 'npm root -g'))
        expect(c).toContain('--@knead-js:registry=https://registry.npmjs.org/');
    });
  });

  describe('registry preflight', () => {
    test('checks every package exists on npm before publishing any', () => {
      const r = publish('v1.2.3', []);
      expect(r.exitCode).toBe(0);
      const preflight = r.calls.filter((c) => / name --registry=/.test(c));
      expect(preflight).toHaveLength(ALLOWED.length);
      const firstPublish = r.calls.findIndex((c) => c.startsWith('npm publish'));
      const lastPreflight = r.calls.findLastIndex((c) => / name --registry=/.test(c));
      expect(lastPreflight).toBeLessThan(firstPublish);
      expect(preflight[0]).toBe(`npm view ${ALLOWED[0]} name ${REGISTRY_FLAGS}`);
    });

    test('publishes nothing when a package does not exist on npm yet', () => {
      const r = publish('v1.2.3', [], { env: { FAKE_MISSING: '@knead-js/testing' } });
      expectRejected(r, '@knead-js/testing is not on npm yet');
      expect(r.output).toContain('trust:npm');
    });

    test('publishes nothing when the preflight query fails', () => {
      const r = publish('v1.2.3', [], { env: { FAKE_PREFLIGHT_ERROR: 'ETIMEDOUT' } });
      expectRejected(r, `could not query npm for ${ALLOWED[0]}`);
    });
  });

  describe('full set', () => {
    test('publishes every allowed package', () => {
      const r = publish('v1.2.3', []);
      expect(r.exitCode).toBe(0);
      expect(r.allPublishes).toHaveLength(ALLOWED.length);
      expect(ALLOWED).toHaveLength(13);
    });

    test('publishes nothing when a package is missing from the artifact', () => {
      const r = publish('v1.2.3', [['@knead-js/core', '1.2.3']], { partial: true });
      expectRejected(
        r,
        `missing from the artifact: ${ALLOWED.filter((n) => n !== '@knead-js/core').join(' ')}`,
      );
    });

    test('publishes nothing when a package appears twice', () => {
      const r = publish('v1.2.3', [
        ['@knead-js/core', '1.2.3'],
        { name: '@knead-js/core', version: '1.2.3', file: 'knead-js-core-1.2.3-copy.tgz' },
      ]);
      expect(r.exitCode).not.toBe(0);
      expect(r.allPublishes).toEqual([]);
    });
  });

  describe('package allowlist', () => {
    test.each(['evil', '@knead-js/evil', '@knead-js/core-evil', '@knead-js/cor', '@KNEAD/core'])(
      'publishes nothing for %p',
      (name) => {
        const r = publish('v1.2.3', [
          ['@knead-js/core', '1.2.3'],
          { name, version: '1.2.3', file: 'zz-evil-1.2.3.tgz' },
        ]);
        expectRejected(r, `unexpected package ${name}`);
      },
    );

    test('publishes nothing when the tarball name does not match its manifest', () => {
      const r = publish('v1.2.3', [
        { name: '@knead-js/http', version: '1.2.3', file: 'knead-js-core-1.2.3.tgz' },
      ]);
      expectRejected(r, 'expected file knead-js-http-1.2.3.tgz');
    });
  });

  describe('SHA256SUMS', () => {
    test('is required', () => {
      expectRejected(
        publish('v1.2.3', [['@knead-js/core', '1.2.3']], {
          noSums: true,
          sumsDigest: 'a'.repeat(64),
        }),
        'SHA256SUMS is missing',
      );
    });

    test('must match the digest reported by the build job', () => {
      const r = publish('v1.2.3', [['@knead-js/core', '1.2.3']], { sumsDigest: '0'.repeat(64) });
      expectRejected(r, 'does not match the digest');
    });

    test('a missing build-job digest stops the release', () => {
      const r = publish('v1.2.3', [['@knead-js/core', '1.2.3']], { sumsDigest: '' });
      expectRejected(r, 'no SHA256SUMS digest');
    });

    test('rejects SHA256SUMS edited after the build job reported its digest', () => {
      const r = publish('v1.2.3', [['@knead-js/core', '1.2.3']], {
        tamperSums: (s) => `${'f'.repeat(64)}${s.slice(64)}`,
      });
      expectRejected(r, 'does not match the digest');
    });

    test('rejects a tarball whose checksum does not match even when the digest is consistent', () => {
      const r = publishWithConsistentDigest(
        'v1.2.3',
        [['@knead-js/core', '1.2.3']],
        (s) => `${'f'.repeat(64)}${s.slice(64)}`,
      );
      expectRejected(r, 'does not match SHA256SUMS');
    });

    test('rejects a malformed line', () => {
      const r = publishWithConsistentDigest('v1.2.3', [['@knead-js/core', '1.2.3']], (s) =>
        s.replace('  knead-js-core', '  ../knead-js-core'),
      );
      expectRejected(r, 'malformed line');
    });

    test('rejects a tarball that SHA256SUMS does not list', () => {
      const r = publish('v1.2.3', [['@knead-js/core', '1.2.3']], {
        unlisted: [{ name: '@knead-js/http', version: '1.2.3' }],
      });
      expectRejected(r, 'differ from those listed');
    });

    test('rejects a listed tarball that is missing', () => {
      const r = publishWithConsistentDigest(
        'v1.2.3',
        [['@knead-js/core', '1.2.3']],
        (s) => `${s}${'a'.repeat(64)}  knead-js-http-1.2.3.tgz\n`,
      );
      expectRejected(r, 'differ from those listed');
    });

    test('rejects a duplicated line', () => {
      const r = publishWithConsistentDigest('v1.2.3', [['@knead-js/core', '1.2.3']], (s) => s + s);
      expectRejected(r, 'differ from those listed');
    });
  });

  describe('tarball contents', () => {
    test('accepts the files a package ships, including LICENSE files and nested dist', () => {
      const r = publish('v1.2.3', [
        {
          name: '@knead-js/core',
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
          name: '@knead-js/core',
          version: '1.2.3',
          duplicateManifest: {
            name: '@knead-js/core',
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
      const r = publish('v1.2.3', [{ name: '@knead-js/core', version: '1.2.3', files: [entry] }]);
      expectRejected(r, `unexpected entries: - ${entry}`);
    });

    test('rejects a symlink, even inside dist', () => {
      const r = publish('v1.2.3', [
        {
          name: '@knead-js/core',
          version: '1.2.3',
          symlinks: [['package/dist/x.js', '/etc/passwd']],
        },
      ]);
      expectRejected(r, 'unexpected entries: l package/dist/x.js');
    });
  });

  describe('GNU tar and npm must read the tarball the same way', () => {
    test('the sparse-name PoC really differs between GNU tar and node-tar', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'knead-poc-'));
      dirs.push(tmp);
      writeFileSync(join(tmp, 'poc.tar'), sparseNameSwap('@knead-js/core', '1.2.3'));
      const gnu = JSON.parse(sh(['tar', '-xOf', 'poc.tar', 'package/package.json'], tmp));
      expect(gnu.scripts).toBeUndefined();
      const npmRoot = sh([REAL_NPM as string, 'root', '-g']).trim();
      const viaNpm = sh([
        'node',
        '-e',
        `require(${JSON.stringify(join(npmRoot, 'npm/node_modules/pacote'))})
          .manifest(${JSON.stringify(join(tmp, 'poc.tar'))})
          .then((m) => console.log(JSON.stringify(m.scripts)))`,
      ]);
      expect(JSON.parse(viaNpm)).toEqual({ postinstall: 'node -e "1"' });
    });

    test('rejects the GNU.sparse.name PoC', () => {
      const r = publish('v1.2.3', [
        {
          name: '@knead-js/core',
          version: '1.2.3',
          raw: sparseNameSwap('@knead-js/core', '1.2.3'),
        },
      ]);
      expectRejected(r, 'GNU sparse');
    });

    test('rejects a PAX path that differs from the header name', () => {
      const raw = rawTar([
        {
          name: 'package/dist/x.js',
          data: '{"name":"@knead-js/core","version":"1.2.3","description":"test"}',
          pax: { path: 'package/package.json' },
        },
        { name: 'package/README.md', data: '# readme' },
      ]);
      expectRejected(
        publish('v1.2.3', [{ name: '@knead-js/core', version: '1.2.3', raw }]),
        'PAX path',
      );
    });

    test.each([
      [{ comment: 'x' }, 'PAX key comment'],
      [{ linkpath: '/etc/passwd' }, 'PAX key linkpath'],
      // GNU tar itself refuses this one; either way nothing is published.
      [{ 'GNU.sparse.major': '1' }, '::error::'],
    ])('rejects PAX records %j', (pax, message) => {
      const raw = rawTar([
        {
          name: 'package/package.json',
          data: '{"name":"@knead-js/core","version":"1.2.3","description":"test"}',
          pax,
        },
      ]);
      expectRejected(
        publish('v1.2.3', [{ name: '@knead-js/core', version: '1.2.3', raw }]),
        message,
      );
    });

    test.each(['S', 'g', 'L', 'K', '1', '2'])('rejects entry type %p', (type) => {
      const raw = rawTar([
        {
          name: 'package/package.json',
          data: '{"name":"@knead-js/core","version":"1.2.3","description":"test"}',
        },
        { name: 'package/dist/x.js', data: 'x', type },
      ]);
      const r = publish('v1.2.3', [{ name: '@knead-js/core', version: '1.2.3', raw }]);
      expect(r.exitCode).not.toBe(0);
      expect(r.allPublishes).toEqual([]);
    });

    test('rejects data after the end-of-archive marker', () => {
      const trailer = padBlock(
        Buffer.concat([rawHeader('package/dist/late.js', 1, '0'), Buffer.from('x')]),
      );
      const raw = rawTar(
        [
          {
            name: 'package/package.json',
            data: '{"name":"@knead-js/core","version":"1.2.3","description":"test"}',
          },
        ],
        trailer,
      );
      expectRejected(
        publish('v1.2.3', [{ name: '@knead-js/core', version: '1.2.3', raw }]),
        'after the end-of-archive',
      );
    });

    test('accepts a well-formed tarball written by the raw writer', () => {
      const raw = rawTar([
        {
          name: 'package/package.json',
          data: '{"name":"@knead-js/core","version":"1.2.3","description":"test"}',
        },
        { name: 'package/dist/index.js', data: 'export {};' },
      ]);
      const r = publish('v1.2.3', [{ name: '@knead-js/core', version: '1.2.3', raw }]);
      expect(r.exitCode).toBe(0);
      expect(r.publishes).toHaveLength(1);
    });
  });

  describe('size limits', () => {
    test('rejects a tarball over 10 MiB before reading it', () => {
      const r = publish('v1.2.3', [
        {
          name: '@knead-js/core',
          version: '1.2.3',
          blobs: [['package/dist/big.js', randomBytes(11 * 1024 * 1024)]],
        },
      ]);
      expectRejected(r, 'knead-js-core-1.2.3.tgz is larger than 10 MiB');
    });

    test('rejects a gzip bomb', () => {
      const r = publish('v1.2.3', [
        {
          name: '@knead-js/core',
          version: '1.2.3',
          blobs: [['package/dist/zeros.js', Buffer.alloc(80 * 1024 * 1024)]],
        },
      ]);
      expectRejected(r, 'knead-js-core-1.2.3.tgz unpacks to more than 64 MiB');
    });

    test('rejects a package.json over 1 MiB', () => {
      const r = publish('v1.2.3', [
        {
          name: '@knead-js/core',
          version: '1.2.3',
          manifest: { description: 'x'.repeat(1024 * 1024) },
        },
      ]);
      expectRejected(r, 'package.json is larger than 1 MiB');
    });
  });

  describe('dependency allowlist', () => {
    test('accepts the dependencies a package is allowed', () => {
      const r = publish('v1.2.3', [
        {
          name: '@knead-js/graphql',
          version: '1.2.3',
          manifest: {
            dependencies: { dataloader: '2.2.3', '@leaven-graphql/core': '0.2.2' },
            peerDependencies: {
              graphql: '^16',
              '@knead-js/core': '1.2.3',
              '@knead-js/http': '1.2.3',
            },
          },
        },
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.publishes).toHaveLength(1);
    });

    test.each([
      ['dependencies', { 'left-pad': '1.0.0' }, 'left-pad'],
      ['optionalDependencies', { 'left-pad': '1.0.0' }, 'left-pad'],
      ['peerDependencies', { 'left-pad': '1.0.0' }, 'left-pad'],
      // Allowed for @knead-js/graphql, not for @knead-js/core.
      ['dependencies', { dataloader: '2.2.3' }, 'dataloader'],
      ['peerDependencies', { graphql: '^16' }, 'graphql'],
    ])('rejects %s %j on @knead-js/core', (field, deps, dep) => {
      const r = publish('v1.2.3', [
        { name: '@knead-js/core', version: '1.2.3', manifest: { [field]: deps } },
      ]);
      expectRejected(r, `@knead-js/core: dependency ${dep} is not allowed`);
    });
  });

  describe('normalisation by npm publish', () => {
    test.each([
      [{ repository: 'github:quinnjr/x' }],
      [{ author: 'A <a@example.com>' }],
      [{ keywords: 'a,b' }],
    ])('rejects %j, which npm publish would rewrite', (manifest) => {
      const r = publish('v1.2.3', [{ name: '@knead-js/core', version: '1.2.3', manifest }]);
      expectRejected(r, 'npm reads a different package.json');
    });

    test('ignores the readme, bugs and homepage fields pacote derives', () => {
      const r = publish('v1.2.3', [
        {
          name: '@knead-js/core',
          version: '1.2.3',
          manifest: {
            repository: {
              type: 'git',
              url: 'git+https://github.com/quinnjr/knead.git',
              directory: 'packages/core',
            },
          },
        },
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.publishes).toHaveLength(1);
    });
  });

  describe('bin shims', () => {
    test.each([
      [{ bin: { x: 'dist/index.js' } }, 'may not declare bin, directories or man'],
      [{ directories: { lib: 'dist' } }, 'may not declare bin, directories or man'],
      // npm publish normalises these, so the cross-check refuses them first.
      [{ bin: 'dist/index.js' }, 'npm reads a different package.json'],
      [{ man: './dist/x.1' }, 'npm reads a different package.json'],
      [{ directories: { bin: 'dist' } }, 'npm reads a different package.json'],
    ])('rejects %j', (manifest, message) => {
      const r = publish('v1.2.3', [{ name: '@knead-js/core', version: '1.2.3', manifest }]);
      expectRejected(r, message);
    });
  });

  describe('manifest', () => {
    test.each([
      [
        { publishConfig: { registry: 'https://evil.example/' } },
        'publishConfig may only set access',
      ],
      [
        { publishConfig: { '@knead-js:registry': 'https://evil.example/' } },
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
      // pacote normalises these, so the cross-check catches them before the jq checks.
      [{ scripts: 'x' }, 'npm reads a different package.json'],
      [{ bundleDependencies: ['x'] }, 'npm reads a different package.json'],
      [{ bundledDependencies: true }, 'npm reads a different package.json'],
      [{ name: 42 }, 'pacote cannot read it'],
    ])('rejects %j', (manifest, message) => {
      const r = publish('v1.2.3', [
        { name: '@knead-js/core', version: '1.2.3', manifest: manifest as Record<string, unknown> },
      ]);
      expectRejected(r, message);
    });

    test('accepts publishConfig.access and ordinary scripts', () => {
      const r = publish('v1.2.3', [
        {
          name: '@knead-js/core',
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

describe('release.yml build job', () => {
  const build = workflow.jobs.build?.steps;
  const index = (pred: (s: Step) => boolean) => build?.findIndex(pred) ?? -1;

  test('checks the packed tarballs themselves, after packing and before SHA256SUMS', () => {
    const pack = index((s) => s.name === 'Pack publishable packages');
    const check = index((s) => s.name === 'Check packed tarballs');
    const sums = index((s) => s.name === 'Write SHA256SUMS');
    expect(build?.[pack]?.run).toBe('bun scripts/release.ts pack "$RUNNER_TEMP/npm-tarballs"');
    expect(build?.[check]?.run).toBe(
      'bun scripts/check-pack.ts --tarballs "$RUNNER_TEMP/npm-tarballs"',
    );
    expect(pack).toBeGreaterThan(index((s) => s.run === 'pnpm build'));
    expect(check).toBe(pack + 1);
    expect(sums).toBe(check + 1);
    // No second, separately packed set.
    expect(index((s) => s.run === 'pnpm check:pack')).toBe(-1);
  });
});

describe('toolchain pins', () => {
  const names = ['ci.yml', 'release.yml', 'docs.yml'];
  const workflows = names.map(
    (name) =>
      Bun.YAML.parse(readFileSync(join(import.meta.dir, '../.github/workflows', name), 'utf8')) as {
        env: Record<string, string>;
        jobs: Record<string, { steps?: Step[] }>;
      },
  );

  test('every workflow pins the same Node, Bun and Bun revision', () => {
    const pins = workflows.map(({ env }) => [env.NODE_VERSION, env.BUN_VERSION, env.BUN_REVISION]);
    expect(pins[0]?.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
    for (const p of pins) expect(p).toEqual(pins[0] as string[]);
  });

  test.each(names)('%s checks the pnpm, Node and Bun versions it set up', (name) => {
    const wf = workflows[names.indexOf(name)];
    const steps = Object.values(wf?.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .map((s) => s.name);
    for (const check of ['Check pnpm version', 'Check Node version', 'Check Bun revision'])
      expect(steps).toContain(check);
  });
});
