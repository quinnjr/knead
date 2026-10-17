import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Config } from './config.js';
import type { ConfigHandle, ConfigSchema } from './define.js';
import { type ConfigIssue, ConfigLoaderError, ConfigValidationError } from './errors.js';
import { convertSource, toScreamingSnake } from './keys.js';

type StringRecord = Readonly<Record<string, string | undefined>>;

export type ConfigLoader = () => StringRecord | Promise<StringRecord>;

export interface ConfigSources<S extends ConfigSchema> {
  /** Run concurrently; later loaders win over earlier ones and over `process.env`. */
  loaders?: readonly ConfigLoader[];
  /** Highest precedence. Only declared keys are used. */
  values?: Partial<StandardSchemaV1.InferInput<S>>;
}

function segment(s: PropertyKey | StandardSchemaV1.PathSegment): string {
  return String(typeof s === 'object' ? s.key : s);
}

function describeIssue(
  topKey: string | undefined,
  merged: Record<string, unknown>,
  winners: ReadonlyMap<string, string>,
): ConfigIssue {
  const key = topKey;
  // Only the declared top-level key is ever kept: deeper segments can be derived from values
  // (record keys, keys of a transformed secret), so they never reach issues or messages.
  if (key === undefined)
    return { key: '(root)', name: '(schema)', path: [], message: 'Invalid value' };
  return {
    key,
    name: winners.get(key) ?? toScreamingSnake(key),
    path: [key],
    message: Object.hasOwn(merged, key) ? 'Invalid value' : 'Missing value',
  };
}

async function runLoader(loader: ConfigLoader, index: number): Promise<StringRecord> {
  let result: unknown;
  try {
    // The deferral starts every loader outside the injection context (so inject() in a loader
    // throws InjectionContextError) and turns a synchronous throw into a rejection.
    result = await Promise.resolve().then(loader);
  } catch (cause) {
    throw new ConfigLoaderError(index, loader.name, { cause });
  }
  if (result === null || typeof result !== 'object') {
    throw new ConfigLoaderError(index, loader.name, {
      cause: new TypeError('Config loader must return an object.'),
    });
  }
  return result as StringRecord;
}

export async function loadConfig<S extends ConfigSchema>(
  handle: ConfigHandle<S>,
  sources: ConfigSources<S> = {},
  env: StringRecord = process.env,
): Promise<Config<StandardSchemaV1.InferOutput<S>>> {
  const layers = [convertSource(env, handle.keys, 'process.env')];

  const loaders = sources.loaders ?? [];
  const results = await Promise.all(loaders.map((loader, i) => runLoader(loader, i)));
  results.forEach((result, i) => {
    layers.push(convertSource(result, handle.keys, `loader #${i}`));
  });

  const values = new Map<string, { value: unknown; from: string }>();
  for (const [key, value] of Object.entries(sources.values ?? {})) {
    if (value !== undefined && handle.keys.has(key)) values.set(key, { value, from: key });
  }
  layers.push(values);

  const merged: Record<string, unknown> = {};
  const winners = new Map<string, string>();
  for (const layer of layers) {
    for (const [key, { value, from }] of layer) {
      merged[key] = value;
      winners.set(key, from);
    }
  }

  let result: StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>;
  try {
    result = await handle.schema['~standard'].validate(merged);
  } catch {
    // The thrown error may quote an input value (JSON.parse does), so it is dropped, not attached.
    throw new ConfigValidationError([], 'Config schema threw while validating.');
  }
  if (result.issues) {
    const issues = new Map<string, ConfigIssue>();
    for (const issue of result.issues) {
      const first = issue.path?.[0];
      const top = first === undefined ? undefined : segment(first);
      // A key the schema never declared can be derived from a value, so it is a root issue.
      const described = describeIssue(
        top !== undefined && handle.keys.has(top) ? top : undefined,
        merged,
        winners,
      );
      const id = `${described.name}|${described.key}`;
      if (!issues.has(id)) issues.set(id, described);
    }
    throw new ConfigValidationError([...issues.values()]);
  }
  return new Config(result.value);
}
