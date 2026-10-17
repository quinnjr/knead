import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Runs the real script in a throwaway workspace with `pnpm` (and so `pnpm dlx npm@…`) and `sleep`
 * stubbed. `trusted` maps a package to what `npm trust list <pkg> --json` prints; `failList` makes
 * that call fail.
 */
function run(
  packages: string[],
  stub: { trusted?: Record<string, string>; failList?: string[] } = {},
  args: string[] = [],
) {
  const root = mkdtempSync(join(tmpdir(), 'knead-trust-test-'));
  dirs.push(root);
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(import.meta.dir, 'trust-npm-publishers.sh'), join(root, 'scripts', 'run.sh'));
  for (const [i, name] of packages.entries()) {
    mkdirSync(join(root, 'packages', `p${i}`), { recursive: true });
    writeFileSync(join(root, 'packages', `p${i}`, 'package.json'), JSON.stringify({ name }));
  }
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const responses = join(root, 'responses');
  mkdirSync(responses);
  for (const [name, body] of Object.entries(stub.trusted ?? {})) {
    writeFileSync(join(responses, encodeURIComponent(name)), body);
  }
  const log = join(root, 'calls.log');
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/usr/bin/env bash
# pnpm dlx npm@<version> <args...>
shift 2
echo "$*" >> ${JSON.stringify(log)}
if [ "$1 $2" = "trust list" ]; then
  case " ${(stub.failList ?? []).join(' ')} " in *" $3 "*) echo "npm error 404" >&2; exit 1 ;; esac
  file=${JSON.stringify(responses)}/$(node -p 'encodeURIComponent(process.argv[1])' "$3")
  [ -f "$file" ] && cat "$file"
fi
exit 0
`,
  );
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(bin, 'pnpm'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);
  const r = Bun.spawnSync(['bash', join(root, 'scripts', 'run.sh'), ...args], {
    cwd: root,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: root },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n');
  } catch {}
  return {
    exitCode: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
    creates: calls.filter((c) => c.startsWith('trust github')),
  };
}

const GITHUB_TRUST = `{
  "id": "abc",
  "type": "github",
  "file": "release.yml",
  "repository": "quinnjr/knead",
  "permissions": ["createPackage"]
}
`;

describe('trust-npm-publishers.sh', () => {
  test('creates a trust for packages that have none', () => {
    const r = run(['@knead-js/a', '@knead-js/b']);
    expect(r.exitCode).toBe(0);
    expect(r.creates).toHaveLength(2);
    expect(r.creates[0]).toContain(
      'trust github @knead-js/a --file release.yml --repo quinnjr/knead',
    );
  });

  test('skips packages that already have a trusted publisher, without failing', () => {
    const r = run(['@knead-js/a', '@knead-js/b'], { trusted: { '@knead-js/a': GITHUB_TRUST } });
    expect(r.exitCode).toBe(0);
    expect(r.creates).toEqual([expect.stringContaining('trust github @knead-js/b ')]);
    expect(r.out).toContain('@knead-js/a already has a trusted publisher, skipping');
  });

  test('any existing trust counts, even one for another workflow', () => {
    const other = GITHUB_TRUST.replace('release.yml', 'other.yml');
    const r = run(['@knead-js/a'], { trusted: { '@knead-js/a': `${GITHUB_TRUST}\n${other}` } });
    expect(r.exitCode).toBe(0);
    expect(r.creates).toEqual([]);
  });

  test('an empty list creates the trust', () => {
    const r = run(['@knead-js/a'], { trusted: { '@knead-js/a': '' } });
    expect(r.exitCode).toBe(0);
    expect(r.creates).toHaveLength(1);
  });

  test('when listing fails, it still tries to create the trust', () => {
    const r = run(['@knead-js/a'], { failList: ['@knead-js/a'] });
    expect(r.exitCode).toBe(0);
    expect(r.creates).toHaveLength(1);
  });

  test('--dry-run reports skips and passes through to the create call', () => {
    const r = run(['@knead-js/a', '@knead-js/b'], { trusted: { '@knead-js/a': GITHUB_TRUST } }, [
      '--dry-run',
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('@knead-js/a already has a trusted publisher, skipping');
    expect(r.creates).toEqual([expect.stringContaining('@knead-js/b --file release.yml')]);
    expect(r.creates[0]).toContain('--dry-run');
  });
});
