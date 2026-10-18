// The manifest and entry rules the publish job of .github/workflows/release.yml applies to every
// tarball, applied here to the real tarballs by check-pack.ts, so a pull request that would make
// the release refuse to publish fails CI instead. The publish job runs no repository code, so it
// cannot import this module: the rules are read from the publish step itself (its regexes, its
// lifecycle-script filter and its ALLOWED_DEPENDENCIES), and the checks around them are ported.
import { readFileSync } from 'node:fs';

export interface PublishRules {
  /** One `<type> <path>` line of `tar -tv` output (type `-` file, `d` directory). */
  entry: RegExp;
  /** A plain registry range, the only dependency specifier that may be published. */
  range: RegExp;
  /** A script name npm runs on its own (install, publish and pack hooks). */
  lifecycle: RegExp;
  /** The dependency names each package may declare. */
  allowedDependencies: Map<string, Set<string>>;
}

/** A tarball entry as GNU tar lists it. */
export interface TarEntry {
  /** The first column of `tar -tv`: `-` file, `d` directory, `l` symlink, ... */
  type: string;
  name: string;
}

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

/** Reads the publish step's rules from release.yml; throws when one cannot be found. */
export function loadPublishRules(workflowPath: string): PublishRules {
  const workflow = Bun.YAML.parse(readFileSync(workflowPath, 'utf8')) as {
    jobs?: Record<string, { steps?: Step[] }>;
  };
  const step = workflow.jobs?.publish?.steps?.find((s) => s.name === 'Publish tarballs');
  if (!step?.run) throw new Error(`${workflowPath}: no "Publish tarballs" step in jobs.publish`);
  // The step builds entry_re and range_re from shell variables: evaluate exactly those
  // assignments (literal strings and parameter expansions, no commands) to get the regexes.
  const defs = step.run
    .split('\n')
    .filter((l) => /^\s*(seg|entry_re|comparator|range_re)=/.test(l))
    .join('\n');
  if (/[`]|\$\(/.test(defs)) throw new Error('publish step regex definitions run commands');
  const r = Bun.spawnSync(['bash', '-c', `${defs}\nprintf '%s\\0' "$entry_re" "$range_re"`], {
    env: {},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [entry, range] = r.stdout.toString().split('\0');
  if (r.exitCode !== 0 || !entry?.startsWith('^') || !range?.startsWith('^')) {
    throw new Error('could not read entry_re and range_re from the publish step');
  }
  const lifecycle = /\(keys \| any\(test\("([^"]+)"; "i"\)\)\)/.exec(step.run)?.[1];
  if (!lifecycle)
    throw new Error('could not read the lifecycle-script filter from the publish step');
  const allowed = step.env?.ALLOWED_DEPENDENCIES;
  if (typeof allowed !== 'string') throw new Error('the publish step has no ALLOWED_DEPENDENCIES');
  return {
    entry: new RegExp(entry),
    range: new RegExp(range),
    lifecycle: new RegExp(lifecycle, 'i'),
    allowedDependencies: parseAllowedDependencies(allowed),
  };
}

/** `ALLOWED_DEPENDENCIES` lines (`<package>: <dep> <dep> ...`) as a map. */
export function parseAllowedDependencies(text: string): Map<string, Set<string>> {
  const allowed = new Map<string, Set<string>>();
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':', 1);
    if (!line.trim() || colon < 0) continue;
    const name = line.slice(0, colon).trim();
    // A package listed twice is refused by the step (it allows nothing), so allow nothing here.
    allowed.set(
      name,
      allowed.has(name)
        ? new Set()
        : new Set(
            line
              .slice(colon + 1)
              .split(' ')
              .filter(Boolean),
          ),
    );
  }
  return allowed;
}

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

/** The reasons the publish step would refuse a tarball with this manifest and listing. */
export function publishProblems(
  manifest: Record<string, unknown>,
  entries: readonly TarEntry[],
  rules: PublishRules,
): string[] {
  const problems: string[] = [];
  const names = entries.map((e) => e.name);
  const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (duplicates.length) problems.push(`duplicate entries: ${duplicates.join(', ')}`);
  for (const e of entries) {
    const line = `${e.type} ${e.name}`;
    if (!rules.entry.test(line)) problems.push(`unexpected entry: ${line}`);
  }
  if (!entries.some((e) => e.type === '-' && e.name === 'package/package.json'))
    problems.push('no package/package.json');

  const publishConfig = manifest.publishConfig ?? {};
  if (
    typeof publishConfig !== 'object' ||
    publishConfig === null ||
    Array.isArray(publishConfig) ||
    Object.keys(publishConfig).some((k) => k !== 'access')
  ) {
    problems.push('publishConfig may only set access (no registry or other overrides)');
  }
  const scripts = manifest.scripts ?? {};
  if (
    typeof scripts !== 'object' ||
    scripts === null ||
    Array.isArray(scripts) ||
    Object.keys(scripts).some((k) => rules.lifecycle.test(k))
  ) {
    problems.push('package.json has lifecycle scripts');
  }
  if ('bundleDependencies' in manifest || 'bundledDependencies' in manifest)
    problems.push('package.json has bundled dependencies');
  if ('bin' in manifest || 'directories' in manifest || 'man' in manifest)
    problems.push('package.json may not declare bin, directories or man');

  const ok = rules.allowedDependencies.get(String(manifest.name)) ?? new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (deps === undefined || deps === null) continue;
    if (typeof deps !== 'object' || Array.isArray(deps)) {
      problems.push(`${field} is not an object`);
      continue;
    }
    for (const [dep, spec] of Object.entries(deps)) {
      if (!ok.has(dep))
        problems.push(`dependency ${dep} is not allowed (see ALLOWED_DEPENDENCIES)`);
      if (typeof spec !== 'string' || !rules.range.test(spec))
        problems.push(`dependency ${dep} has a non-registry specifier`);
    }
  }
  return problems;
}

/** The entries of a gzipped tarball, read with GNU tar exactly as the publish step reads them. */
export function listTarball(tarball: string): TarEntry[] {
  const tar = (args: string[]) => {
    const r = Bun.spawnSync(['tar', ...args, tarball], { stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`tar ${args.join(' ')} failed: ${r.stderr.toString()}`);
    return r.stdout.toString().split('\n').filter(Boolean);
  };
  const names = tar(['-tzf']);
  const types = tar(['-tvzf']).map((l) => l.charAt(0));
  if (names.length !== types.length) throw new Error('unreadable tarball listing');
  return names.map((name, i) => ({ type: types[i]!, name }));
}

/**
 * The files `exports` maps a package's entry points to, without the leading `./` (`dist/index.js`
 * and `dist/index.d.ts` for `{ ".": { types, default } }`).
 */
export function exportTargets(exports: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'string') found.add(value.replace(/^\.\//, ''));
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
  };
  walk(exports);
  return [...found];
}
