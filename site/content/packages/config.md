---
title: @knead-js/config
description: API reference for typed, validated configuration from environment variables, async loaders and code.
---

```bash
bun add @knead-js/core @knead-js/config
```

`@knead-js/core` is a peer dependency. You also need a schema library with Standard JSON Schema
support: Zod 4.2+, ArkType 2.1.28+, or Valibot 1.5+ with `@valibot/to-json-schema`
(`bun add valibot @valibot/to-json-schema`).

The package loads configuration once at startup from `process.env`, async loaders and code,
validates it with your schema, and provides it as an injectable, deep-frozen `Config` that never
prints its values. The [configuration guide](/guide/configuration/) walks through it with
examples.

## Defining configuration

### `defineConfig()`

```text
defineConfig<S extends ConfigSchema>(schema: S, options?: { name?: string }): ConfigHandle<S>
```

Reads the schema's declared top-level properties (through `~standard.jsonSchema.input()`, draft
2020-12) and returns a `ConfigHandle` for them.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | `'Config'` | The handle's token description, shown in dependency injection errors. |

Throws `ConfigDefinitionError` when:

- the schema has no `~standard.jsonSchema` (the message names Zod 4.2+, ArkType 2.1.28+ and
  Valibot with `toStandardJsonSchema()`);
- the JSON Schema conversion throws (`Could not convert the config schema to JSON Schema.`, with
  the library's error as `cause`);
- the top level is not an object schema with a `properties` object (for example a `$ref`,
  `allOf` or `anyOf`);
- a key is not camelCase that a `SCREAMING_SNAKE_CASE` name converts to, such as `DATABASE_URL`,
  `api_key` or `Port` (the message suggests `databaseUrl`, `apiKey`, `port`).

### `ConfigHandle`

```text
class ConfigHandle<S extends ConfigSchema> extends InjectionToken<Config<StandardSchemaV1.InferOutput<S>>> {
  readonly schema: S;
  readonly keys: ReadonlySet<string>;
}
```

The injection token for one configuration, returned by `defineConfig()`. `inject(handle)` returns
a `Config` typed by the schema's output. `schema` is the schema you passed, `keys` the declared
top-level keys, and `description` (from `InjectionToken`) the `name` option.

### `ConfigSchema`

```text
type ConfigSchema = StandardSchemaV1 & StandardJSONSchemaV1;
```

A schema that implements both [Standard Schema](https://standardschema.dev) (validation) and
Standard JSON Schema (key discovery).

## Registering configuration

### `ConfigModule`

A global module: once imported anywhere, every module can inject the handle. Each registration
provides and exports exactly one handle; register several handles with several calls.

#### `ConfigModule.forRoot()`

```text
ConfigModule.forRoot<S extends ConfigSchema>(handle: ConfigHandle<S>, sources?: ConfigSources<S>): DynamicModule
```

Loads `handle` from `process.env` plus the given `sources` while the application is created. A
loading or validation error rejects `KneadFactory.create()` (or `compile()` in tests).

#### `ConfigModule.forRootAsync()`

```text
ConfigModule.forRootAsync<S extends ConfigSchema>(handle: ConfigHandle<S>, options: ConfigModuleAsyncOptions<S>): DynamicModule
```

Like `forRoot()`, with the sources computed by a factory that can inject providers.

### `ConfigModuleAsyncOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `imports` | `ModuleImport[]` | `[]` | Modules whose exports `useFactory` injects. |
| `useFactory` | `() => ConfigSources<S> \| Promise<ConfigSources<S>>` | required | Returns the sources. Runs inside the injection context, so it may call `inject()`; it can run again from the start when one of its `inject()` calls waits for an async provider, so keep it free of side effects before them. |

### `ConfigSources`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `loaders` | `readonly ConfigLoader[]` | `[]` | Run concurrently, once. Later loaders win over earlier ones and over `process.env`. Their keys are converted like environment names. |
| `values` | `Partial<StandardSchemaV1.InferInput<S>>` | `{}` | Highest precedence. camelCase keys with schema input types; undeclared keys and `undefined` values are ignored. |

### `ConfigLoader`

```text
type ConfigLoader = () => Readonly<Record<string, string | undefined>> | Promise<Readonly<Record<string, string | undefined>>>
```

A source of `SCREAMING_SNAKE_CASE` names and string values. Every loader is started outside the
injection context, so `inject()` inside one throws `InjectionContextError` (reported as the
`cause` of a `ConfigLoaderError`). A loader's function name appears in its error message.

### `loadConfig()`

```text
loadConfig<S extends ConfigSchema>(handle: ConfigHandle<S>, sources?: ConfigSources<S>, env?: Readonly<Record<string, string | undefined>>): Promise<Config<StandardSchemaV1.InferOutput<S>>>
```

The loading step `ConfigModule` runs, usable on its own. `env` defaults to `process.env`. The
steps:

1. Convert each source's names to camelCase and keep only declared keys. Names that are not
   `SCREAMING_SNAKE_CASE` (`^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$`) and `undefined` values are skipped;
   two names mapping to one key in the same source throw `ConfigKeyCollisionError`.
2. Merge `env`, then each loader result in order, then `values`, later sources winning per key.
3. Validate the merged object with the schema once; issues throw `ConfigValidationError`.
4. Wrap the output in a deep-frozen `Config` (see below for what freezing covers).

## Reading configuration

### `Config`

```text
class Config<T> {
  constructor(data: T);
  get<K extends keyof T>(key: K): T[K];
  all(): Readonly<T>;
  toJSON(): Record<keyof T, '[redacted]'>;
}
```

The validated configuration. The constructor deep-freezes `data` in place (cycles are handled),
so `new Config({ ... })` is also how a test builds a replacement value. Freezing covers each object
and array and the values of their own properties (string and symbol keys) at any depth; the
contents of a `Map`, `Set` or `Date` (for example from a schema transform) are not properties, so
they stay mutable. Binary data (a `Uint8Array`, `Buffer`, other typed array, `DataView` or
`ArrayBuffer`) is kept as it is, since a typed array cannot be frozen: its bytes stay mutable.

| Member | Description |
| --- | --- |
| `get(key)` | One value, with the schema's output type. An undeclared key is a compile error. |
| `all()` | The whole frozen object. It holds every secret: do not log it. |
| `toJSON()` | Every key mapped to `'[redacted]'`, so `JSON.stringify(config)` reveals no values. |
| inspection | `console.log(config)` and `Bun.inspect(config)` print `Config {"key":"[redacted]",...}`. |

## Errors

Every error class extends `ConfigError`, which extends core's `KneadError`; `error.name` is the
class name.

| Class | Thrown by | Message | Properties |
| --- | --- | --- | --- |
| `ConfigError` | (base class) | | |
| `ConfigDefinitionError` | `defineConfig()` | See [`defineConfig()`](#defineconfig). | `cause` for a conversion failure |
| `ConfigKeyCollisionError` | loading | `<source>: <A> and <B> both map to config key "<key>".`, where source is `process.env` or `loader #<i>` | `key: string`, `sources: [string, string]` |
| `ConfigLoaderError` | loading | `Config loader #<i> (<function name, or anonymous>) failed.` | `index: number`, non-enumerable `cause` (the loader's error, or a `TypeError` when it returned a non-object) |
| `ConfigValidationError` | loading | `Config validation failed:` and one line `  <NAME> (<key>): <Missing value or Invalid value>` per issue, or `Config schema threw while validating.` | `issues: readonly ConfigIssue[]` |

Messages and issues never contain configuration values. Issues are deduplicated per name and key.

### `ConfigIssue`

| Field | Type | Description |
| --- | --- | --- |
| `key` | `string` | The config key, or `'(root)'` for an issue on the whole object or an undeclared key. |
| `name` | `string` | The name in the source of the winning value (`JWT_SECRET`, a loader's key, or the camelCase key for `values`); the environment form of the key when no source set it; `'(schema)'` for a root issue. |
| `path` | `string[]` | Always `[key]`, or `[]` for a root issue. Deeper segments are dropped because they can be derived from values. |
| `message` | `string` | `'Missing value'` when no source set the key, otherwise `'Invalid value'`. The schema's own message is never used. |
