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

async function runLoader(loader: ConfigLoader, index: number): Promise<StringRecord> {
  let result: unknown;
  try {
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

  const result = await handle.schema['~standard'].validate(merged);
  if (result.issues) {
    throw new ConfigValidationError(
      result.issues.map((issue): ConfigIssue => {
        const path = (issue.path ?? []).map(segment);
        const key = path[0] ?? '';
        const present = Object.hasOwn(merged, key);
        return {
          key,
          name: winners.get(key) ?? toScreamingSnake(key),
          path,
          message: present ? 'Invalid value' : 'Missing value',
        };
      }),
    );
  }
  return new Config(result.value);
}
