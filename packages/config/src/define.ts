import { InjectionToken } from '@knead-js/core';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { Config } from './config.js';
import { ConfigDefinitionError } from './errors.js';

export type ConfigSchema = StandardSchemaV1 & StandardJSONSchemaV1;

export class ConfigHandle<S extends ConfigSchema> extends InjectionToken<
  Config<StandardSchemaV1.InferOutput<S>>
> {
  constructor(
    description: string,
    readonly schema: S,
    readonly keys: ReadonlySet<string>,
  ) {
    super(description);
  }
}

function readKeys(schema: ConfigSchema): Set<string> {
  const jsonSchema = (schema as Partial<ConfigSchema>)['~standard']?.jsonSchema;
  if (typeof jsonSchema?.input !== 'function') {
    throw new ConfigDefinitionError(
      'defineConfig needs a schema that implements Standard JSON Schema (~standard.jsonSchema), ' +
        'such as Zod 4.2+, ArkType 2.1.28+, or Valibot wrapped with toStandardJsonSchema().',
    );
  }
  let json: unknown;
  try {
    json = jsonSchema.input({ target: 'draft-2020-12' });
  } catch (cause) {
    const error = new ConfigDefinitionError('Could not convert the config schema to JSON Schema.');
    error.cause = cause;
    throw error;
  }
  const { type, properties } = (json ?? {}) as { type?: unknown; properties?: unknown };
  if (type !== 'object' || properties === null || typeof properties !== 'object') {
    throw new ConfigDefinitionError(
      'The config schema must be an object schema with declared properties.',
    );
  }
  return new Set(Object.keys(properties));
}

export function defineConfig<S extends ConfigSchema>(
  schema: S,
  options: { name?: string } = {},
): ConfigHandle<S> {
  return new ConfigHandle(options.name ?? 'Config', schema, readKeys(schema));
}
