// Runs the publish step of .github/workflows/release.yml against fake tarballs with a fake `npm`
// on PATH, so the shell logic the publish job runs is tested without touching the registry.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Step {
  name?: string;
  run?: string;
}
const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, '../.github/workflows/release.yml'), 'utf8'),
) as { jobs: Record<string, { steps: Step[] }> };
const publishStep = workflow.jobs.publish?.steps.find((s) => s.name === 'Publish tarballs')?.run;

// view: prints the version for names in FAKE_EXISTING, fails with FAKE_VIEW_ERROR (default E404).
const fakeNpm = `#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_LOG"
case "$1" in
  view)
    name="\${2%@*}"
    if [[ " $FAKE_EXISTING " == *" $name "* ]]; then echo "\${2##*@}"; exit 0; fi
    echo "npm error code \${FAKE_VIEW_ERROR:-E404}" >&2; exit 1 ;;
  publish) exit 0 ;;
esac
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function publish(tag: string, packages: [string, string][], env: Record<string, string> = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'hpmws-publish-test-'));
  dirs.push(tmp);
  const bin = join(tmp, 'bin');
  const tarballs = join(tmp, 'npm-tarballs');
  mkdirSync(bin);
  mkdirSync(tarballs);
  writeFileSync(join(bin, 'npm'), fakeNpm);
  chmodSync(join(bin, 'npm'), 0o755);
  for (const [name, version] of packages) {
    const src = join(tmp, 'src', name, 'package');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name, version }));
    const file = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
    Bun.spawnSync(['tar', '-czf', join(tarballs, file), '-C', join(src, '..'), 'package']);
  }
  const log = join(tmp, 'npm.log');
  writeFileSync(log, '');
  const r = Bun.spawnSync(['bash', '-e', '-c', publishStep as string], {
    cwd: tarballs,
    env: {
      ...process.env,
      ...env,
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
    publishes: calls.filter((c) => c.startsWith('npm publish')),
  };
}

describe('release.yml publish step', () => {
  test('exists', () => {
    expect(typeof publishStep).toBe('string');
  });

  test('publishes stable versions to latest without running scripts', () => {
    const r = publish('v1.2.3', [['@hpmws/core', '1.2.3']]);
    expect(r.exitCode).toBe(0);
    expect(r.publishes).toEqual([
      'npm publish ./hpmws-core-1.2.3.tgz --access public --tag latest --ignore-scripts',
    ]);
  });

  test.each([
    ['1.0.0-next.2', 'next'],
    ['1.0.0-rc.1', 'rc'],
    ['1.0.0-beta', 'beta'],
    ['1.0.0-0', 'next'],
    ['1.0.0-1', 'next'],
    ['1.0.0-0.3', 'next'],
    ['1.0.0-2beta.1', 'next'],
  ])('prerelease %s publishes to dist-tag %s', (version, distTag) => {
    const r = publish(`v${version}`, [['@hpmws/core', version]]);
    expect(r.exitCode).toBe(0);
    expect(r.publishes).toEqual([
      `npm publish ./hpmws-core-${version}.tgz --access public --tag ${distTag} --ignore-scripts`,
    ]);
  });

  test('skips versions already on npm', () => {
    const r = publish(
      'v1.2.3',
      [
        ['@hpmws/core', '1.2.3'],
        ['@hpmws/http', '1.2.3'],
      ],
      { FAKE_EXISTING: '@hpmws/core' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('skip @hpmws/core@1.2.3');
    expect(r.publishes).toHaveLength(1);
    expect(r.publishes[0]).toContain('hpmws-http-1.2.3.tgz');
  });

  test('publishes nothing when any tarball does not match the tag', () => {
    const r = publish('v1.2.3', [
      ['@hpmws/core', '1.2.3'],
      ['@hpmws/http', '1.2.2'],
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.publishes).toEqual([]);
  });

  test('publishes nothing for a package outside the @hpmws scope', () => {
    const r = publish('v1.2.3', [['evil', '1.2.3']]);
    expect(r.exitCode).not.toBe(0);
    expect(r.publishes).toEqual([]);
  });

  test('stops when npm cannot be queried', () => {
    const r = publish('v1.2.3', [['@hpmws/core', '1.2.3']], { FAKE_VIEW_ERROR: 'ETIMEDOUT' });
    expect(r.exitCode).not.toBe(0);
    expect(r.publishes).toEqual([]);
  });
});
