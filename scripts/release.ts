// Release helpers for the tag-triggered release workflow. Run with bun from the repo root.
//
//   bun scripts/release.ts gate <tag> [ref]  fail unless <tag> is vX.Y.Z and equals the version
//                                            of every publishable package (Changesets fixed mode),
//                                            both in the checkout and at <ref> (default
//                                            origin/main), so only main's HEAD can be released;
//                                            and the tagged commit ($GITHUB_SHA, else HEAD)
//                                            must be the head of <ref>
//   bun scripts/release.ts pack <out-dir>    pack every publishable package into <out-dir>
//
// Both commands also fail unless every publishable package's `repository` names this repository
// and its own directory: npm provenance rejects a publish (E422) whose package.json does not
// match the repository the workflow ran in.
//
// The publish job never runs this file: it only publishes the tarballs `pack` produced.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPOSITORY_URL =
  'git+https://github.com/quinnjr/high-performance-modular-web-server.git';

export interface PublishablePackage {
  name: string;
  version: string;
  /** Absolute path of the package directory. */
  dir: string;
  /** Path relative to the repo root, e.g. `packages/core`. */
  relativeDir: string;
  repository?: unknown;
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
    found.push({
      name: pkg.name,
      version: pkg.version,
      dir,
      relativeDir: `packages/${entry}`,
      repository: pkg.repository,
    });
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

/**
 * Versions of `packages` as committed at git `ref` (e.g. `origin/main`). A package missing at
 * `ref` gets version `undefined`.
 */
export function versionsAtRef(
  root: string,
  ref: string,
  packages: readonly Pick<PublishablePackage, 'name' | 'relativeDir'>[],
): { name: string; version: string | undefined }[] {
  return packages.map((p) => {
    const r = Bun.spawnSync(['git', 'show', `${ref}:${p.relativeDir}/package.json`], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (r.exitCode !== 0) return { name: p.name, version: undefined };
    const version = JSON.parse(r.stdout.toString()).version;
    return { name: p.name, version: typeof version === 'string' ? version : undefined };
  });
}

/**
 * Problems that block releasing `tag` because it is not the version at the head of `ref`. Stops
 * a tag on an older main commit (whose version main has since moved past) from being released.
 */
export function checkVersionAtRef(
  tag: string,
  ref: string,
  atRef: readonly { name: string; version: string | undefined }[],
): string[] {
  const name = tag.replace(/^refs\/tags\//, '');
  const match = RELEASE_TAG.exec(name);
  if (!match) return [`${JSON.stringify(name)} is not a release tag (expected vX.Y.Z)`];
  if (atRef.length === 0) return ['no publishable packages found under packages/'];
  return atRef
    .filter((p) => p.version !== match[1])
    .map((p) =>
      p.version === undefined
        ? `${p.name} does not exist at ${ref}`
        : `${p.name} is at ${p.version} at ${ref} but the tag is ${name}`,
    );
}

/** The commit `ref` points at, or undefined when it cannot be resolved. */
export function revParse(root: string, ref: string): string | undefined {
  const r = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
}

/**
 * Problems that block releasing commit `sha` because it is not the head of `ref`. Together with
 * checkVersionAtRef this means only the tip of main can ever be released.
 */
export function checkCommitIsRefHead(
  sha: string,
  refHead: string | undefined,
  ref: string,
): string[] {
  if (refHead === undefined) return [`${ref} could not be resolved`];
  if (sha !== refHead)
    return [`the tagged commit ${sha} is not the head of ${ref} (${refHead}); tag main's HEAD`];
  return [];
}

/** Problems with the packages' `repository` fields; empty when all point at this repository. */
export function checkRepositoryFields(
  packages: readonly Pick<PublishablePackage, 'name' | 'relativeDir' | 'repository'>[],
): string[] {
  const problems: string[] = [];
  for (const p of packages) {
    const repo =
      typeof p.repository === 'object' && p.repository !== null
        ? (p.repository as Record<string, unknown>)
        : {};
    if (repo.url !== REPOSITORY_URL)
      problems.push(`${p.name}: repository.url must be ${REPOSITORY_URL}`);
    if (repo.directory !== p.relativeDir)
      problems.push(`${p.name}: repository.directory must be ${p.relativeDir}`);
  }
  return problems;
}

function fail(what: string, problems: string[]): never {
  console.error(`${what} failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

function run(cmd: string[], cwd: string): void {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed in ${cwd}`);
}

function pack(root: string, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty`);
  const packages = publishablePackages(root);
  const problems = checkRepositoryFields(packages);
  if (problems.length > 0) fail('pack', problems);
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
  const [command, arg, ref = 'origin/main'] = process.argv.slice(2);
  if (command === 'gate' && arg !== undefined) {
    const packages = publishablePackages(root);
    const problems = [
      ...checkReleaseTag(arg, packages),
      ...checkVersionAtRef(arg, ref, versionsAtRef(root, ref, packages)),
      ...checkCommitIsRefHead(
        process.env.GITHUB_SHA || revParse(root, 'HEAD') || 'HEAD',
        revParse(root, ref),
        ref,
      ),
      ...checkRepositoryFields(packages),
    ];
    if (problems.length > 0) fail('release gate', [...new Set(problems)]);
    console.log(`release gate ok: ${arg} matches ${packages.length} packages and ${ref}`);
  } else if (command === 'pack' && arg) {
    pack(root, resolve(arg));
  } else {
    console.error('usage: bun scripts/release.ts gate <tag> [ref] | pack <out-dir>');
    process.exit(2);
  }
}
