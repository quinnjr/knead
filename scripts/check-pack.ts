// Packs every publishable package and checks the tarball contents. Exits 1 on any problem.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

const required = ['LICENSE-MIT', 'LICENSE-APACHE', 'README.md', 'dist/index.js', 'dist/index.d.ts'];
const forbidden = [/\.map$/, /\.tsbuildinfo$/, /\/src\//, /\/test\//];
const problems: string[] = [];
const tmp = mkdtempSync(join(tmpdir(), 'hpmws-pack-'));

try {
  for (const dir of readdirSync(join(root, 'packages'))) {
    const pkgDir = join(root, 'packages', dir);
    const manifest = join(pkgDir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.private) continue;
    const label = pkg.name as string;
    try {
      run(['pnpm', 'pack', '--pack-destination', tmp], pkgDir);
      const tgz = readdirSync(tmp).find((f) =>
        f.startsWith(`${label.replace('@', '').replace('/', '-')}-`),
      );
      if (!tgz) throw new Error('tarball not found');
      const tarball = join(tmp, tgz);
      const entries = run(['tar', 'tzf', tarball], tmp)
        .split('\n')
        .filter(Boolean)
        .map((e) => e.replace(/^package\//, ''));
      for (const e of entries) {
        if (forbidden.some((re) => re.test(`/${e}`)))
          problems.push(`${label}: forbidden entry ${e}`);
      }
      for (const r of required) {
        if (!entries.includes(r)) problems.push(`${label}: missing ${r}`);
      }
      const packed = run(['tar', 'xzf', tarball, '-O', 'package/package.json'], tmp);
      if (packed.includes('workspace:'))
        problems.push(`${label}: packed package.json contains workspace:`);
      if (JSON.stringify(JSON.parse(packed).exports).includes('/src/'))
        problems.push(`${label}: exports point at src`);
      console.log(`${label}: ${entries.length} entries ok`);
    } catch (err) {
      problems.push(`${label}: ${(err as Error).message}`);
    }
    for (const f of ['LICENSE-MIT', 'LICENSE-APACHE']) rmSync(join(pkgDir, f), { force: true });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`\npack check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('pack check passed');
