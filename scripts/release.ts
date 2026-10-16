// Release helpers for the tag-triggered release workflow. Run with bun from the repo root.
//
//   bun scripts/release.ts gate <tag>        fail unless <tag> is vX.Y.Z and equals the version
//                                            of every publishable package (Changesets fixed mode)
//   bun scripts/release.ts pack <out-dir>    pack every publishable package into <out-dir>
//
// The publish job never runs this file: it only publishes the tarballs `pack` produced.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface PublishablePackage {
  name: string;
  version: string;
  dir: string;
}

/** Every non-private workspace package under packages/, sorted by name. */
export function publishablePackages(root: string): PublishablePackage[] {
  const packagesDir = join(root, 'packages');
  const found: PublishablePackage[] = [];
  for (const entry of readdirSync(packagesDir)) {
    const dir = join(packagesDir, entry);
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.private) continue;
    found.push({ name: pkg.name, version: pkg.version, dir });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// SemVer 2.0 core plus an optional prerelease; no build metadata (npm ignores it).
const RELEASE_TAG =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

/** Problems that block publishing `tag`; empty when the release may proceed. */
export function checkReleaseTag(
  tag: string,
  packages: readonly Pick<PublishablePackage, 'name' | 'version'>[],
): string[] {
  const name = tag.replace(/^refs\/tags\//, '');
  const match = RELEASE_TAG.exec(name);
  if (!match) return [`${JSON.stringify(name)} is not a release tag (expected vX.Y.Z)`];
  if (packages.length === 0) return ['no publishable packages found under packages/'];
  const version = match[1];
  return packages
    .filter((p) => p.version !== version)
    .map((p) => `${p.name} is at ${p.version} but the tag is ${name}`);
}

function run(cmd: string[], cwd: string): void {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed in ${cwd}`);
}

function pack(root: string, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty`);
  const packages = publishablePackages(root);
  for (const pkg of packages) {
    try {
      run(['pnpm', 'pack', '--pack-destination', outDir], pkg.dir);
    } finally {
      // prepack copies the root licenses in; don't leave them in the working tree.
      for (const f of ['LICENSE-MIT', 'LICENSE-APACHE']) rmSync(join(pkg.dir, f), { force: true });
    }
  }
  const tarballs = readdirSync(outDir).filter((f) => f.endsWith('.tgz'));
  for (const pkg of packages) {
    const expected = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`;
    if (!tarballs.includes(expected)) throw new Error(`missing tarball ${expected}`);
  }
  if (tarballs.length !== packages.length)
    throw new Error(`expected ${packages.length} tarballs, found ${tarballs.length}`);
  console.log(`packed ${tarballs.length} packages into ${outDir}`);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const [command, arg] = process.argv.slice(2);
  if (command === 'gate' && arg !== undefined) {
    const packages = publishablePackages(root);
    const problems = checkReleaseTag(arg, packages);
    if (problems.length > 0) {
      console.error(`release gate failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
      process.exit(1);
    }
    console.log(`release gate ok: ${arg} matches ${packages.length} packages`);
  } else if (command === 'pack' && arg) {
    pack(root, resolve(arg));
  } else {
    console.error('usage: bun scripts/release.ts gate <tag> | pack <out-dir>');
    process.exit(2);
  }
}
