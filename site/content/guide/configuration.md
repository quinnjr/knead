---
title: Configuration
description: Define a typed configuration schema once, load it from environment variables, async loaders and code at startup, and inject it anywhere.
---

`@knead-js/config` reads configuration once, while the application boots. You describe the
settings with a schema, `ConfigModule` merges the sources and validates the result, and any
provider reads the typed values with `inject()`. A missing or invalid setting stops startup with
an error that names the variable but never shows its value.

```bash
bun add @knead-js/config @valibot/to-json-schema valibot
```

The examples on this page use [Valibot](https://valibot.dev). Zod 4.2+ and ArkType 2.1.28+ work
too; see [schema libraries](#schema-libraries).

## Define the configuration

Declare every setting the application reads in one object schema and pass it to `defineConfig()`:

<<< config/app-config.ts title="app-config.ts"

`defineConfig()` returns a `ConfigHandle`: an injection token for the validated `Config` object
that also remembers the schema and its declared keys. The `name` option becomes the token's
description (default `'Config'`), which appears in dependency injection errors.

Environment variables are always strings, so the schema parses them: `v.toNumber()` turns
`PORT=8080` into `8080`, and the `signupsOpen` pipe turns `'true'`/`'false'` into a boolean. A
schema that expects a number directly (`v.number()`) rejects every value an environment variable
can hold. Defaults are schema input too, which is why the `port` default is the string `'3000'`.

## Register the module and inject it

Import `ConfigModule.forRoot(handle)` once, in the root module:

<<< config/app.module.ts title="app.module.ts"

`ConfigModule` is a [global module](/guide/modules/), so every provider in the application can
inject the handle without importing anything:

<<< config/signup.service.ts title="signup.service.ts"

`config.get(key)` returns one value with the schema's output type (`number` for `port`,
`boolean` for `signupsOpen`), and an unknown key is a compile error. `config.all()` returns the
whole validated object.

Configuration is loaded and validated while the application is created (`KneadFactory.create()`
or `compile()` in tests), before any `onModuleInit` hook runs. A failure rejects that call, so the
server never starts with a broken configuration.

## Environment variable names

Each source's names are converted from `SCREAMING_SNAKE_CASE` to camelCase, and only names that
convert to a key the schema declares are read:

| Environment variable | Config key |
| --- | --- |
| `PORT` | `port` |
| `DATABASE_URL` | `databaseUrl` |
| `JWT_SECRET` | `jwtSecret` |
| `OAUTH2_CLIENT_ID` | `oauth2ClientId` |

A name is `SCREAMING_SNAKE_CASE` when it starts with an uppercase letter and has only uppercase
letters and digits in words separated by single underscores. Other names (`path`, `Foo_Bar`,
`_PORT`, `DATABASE__URL`) are ignored, and so are names the schema does not declare, such as
`HOME` or `PATH`. A variable whose value is `undefined` is skipped; a variable set to the empty
string is present, and the schema decides whether `''` is valid.

Schema keys must be camelCase that some environment name converts to. `defineConfig()` throws a
`ConfigDefinitionError` for any other key, with a suggestion when there is one:

```text
Config key "DATABASE_URL" can never be read from SCREAMING_SNAKE_CASE sources; declare it in camelCase ("databaseUrl").
```

Bun loads `.env`, `.env.<NODE_ENV>` and `.env.local` into `process.env` by itself, so there is no
dotenv step. See [Bun's environment variable docs](https://bun.sh/docs/runtime/env).

### Key collisions

Digits make two names convert to the same key: `OAUTH2_CLIENT_ID` and `OAUTH_2_CLIENT_ID` are
both `oauth2ClientId`. When two names in the same source map to one declared key, loading fails
with a `ConfigKeyCollisionError` instead of picking one:

```text
process.env: OAUTH2_CLIENT_ID and OAUTH_2_CLIENT_ID both map to config key "oauth2ClientId".
```

The prefix names the source (`process.env`, or `loader #0` for the first loader). Only declared
keys can collide. The same key arriving from two different sources is not a collision: the source
with the higher precedence wins.

## Sources and precedence

Configuration comes from up to three kinds of source. From lowest to highest precedence:

1. `process.env`, read when the module is created.
2. Loaders, in array order: a later loader wins over an earlier one and over `process.env`.
3. `values` passed in code, which win over everything.

The sources are merged key by key and the merged object is validated once, so a schema default
applies only when no source sets the key.

### Values in code

`values` take camelCase keys and schema input types, so for this schema they are strings, exactly
like environment variables:

<<< config/values.ts title="app.module.ts"

Keys the schema does not declare are ignored, and so are keys whose value is `undefined`. Values
are useful for settings that are fixed per deployment artifact, and in tests (see
[testing](#testing)).

### Loaders

A loader is a function that returns an object of strings, or a promise of one
(`ConfigLoader`). Its keys are converted exactly like environment variable names, so a loader
returns `DATABASE_URL`, not `databaseUrl`:

<<< config/loaders.ts title="app.module.ts"

All loaders start at the same time and run once, after `useFactory` (for `forRootAsync`) has
settled. A loader that throws or rejects fails startup with a `ConfigLoaderError` named after its
index and function name, `Config loader #0 (jsonFile) failed.`, with the original error as its
`cause`. A loader that returns something other than an object fails the same way, with the cause
`TypeError: Config loader must return an object.`. An anonymous function appears as
`(anonymous)`, so give loaders a name.

### Loaders that need other providers

When a loader needs a client from another module, such as a secret store, use
`ConfigModule.forRootAsync()`. Its `imports` make that module's exports available, and its
`useFactory` returns the sources (`{ loaders, values }`):

<<< config/async.ts#forRootAsync title="config.module.ts"

`useFactory` runs inside the injection context, so it can call `inject()`. Loaders cannot: they
start after an `await`, and `inject()` inside one fails startup with a `ConfigLoaderError` whose
`cause` is an `InjectionContextError`. Call `inject()` in `useFactory` and close over the result,
as above.

The store in this example is ordinary code from the same file:

<<< config/async.ts title="async.ts"

> [!NOTE]
> When an `inject()` call in `useFactory` waits for an async provider that has not settled yet,
> the container runs `useFactory` again from the start once it has. Keep `useFactory` free of side
> effects before its `inject()` calls. The loaders themselves still run only once.

### Outside a module

`loadConfig(handle, sources?, env?)` runs the same merge and validation without a module and
resolves to a `Config`. Its third argument replaces `process.env`, which is handy for scripts and
tests:

<<< config/load-config.ts title="scripts/migrate.ts"

## Validation errors

When validation fails, startup rejects with a `ConfigValidationError` that lists every problem,
one line per key:

```text
Config validation failed:
  PORT (port): Invalid value
  DATABASE_URL (databaseUrl): Missing value
  JWT_SECRET (jwtSecret): Invalid value
```

Each line shows the name in the source that supplied the winning value (here the environment
variable), the config key, and one of two messages:

- `Missing value`: no source set the key.
- `Invalid value`: some source set it and the schema rejected it.

When the value came from `values`, the name is the camelCase key (`jwtSecret (jwtSecret)`). When
the key is missing, the name is the environment form of the key. The same problems are on
`error.issues` as `ConfigIssue` objects:

```json
[
  { "key": "port", "name": "PORT", "path": ["port"], "message": "Invalid value" },
  { "key": "databaseUrl", "name": "DATABASE_URL", "path": ["databaseUrl"], "message": "Missing value" },
  { "key": "jwtSecret", "name": "JWT_SECRET", "path": ["jwtSecret"], "message": "Invalid value" }
]
```

The schema's own messages are deliberately discarded, because a validation message can quote the
rejected input, and the input may be a secret. For the same reason `path`
keeps only the top-level key: deeper segments can be derived from values. An issue the schema
reports on the whole object, or on a key it does not declare, appears as
`(schema) ((root)): Invalid value`. A schema that throws instead of returning issues fails with
`ConfigValidationError: Config schema threw while validating.` and an empty `issues` list, and
the thrown error is dropped, since it may quote a value.

## Secrets

Configuration usually holds credentials, so `Config` keeps them out of logs and responses by
default:

- `JSON.stringify(config)` writes `[redacted]` for every key, for example
  `{"port":"[redacted]","jwtSecret":"[redacted]"}`, and so does `console.log(config)` or
  `Bun.inspect(config)` (`Config {"port":"[redacted]",...}`).
- Error messages name variables and keys, never values.
- The validated object is deep-frozen, so nothing can change a setting after boot. Changing
  `process.env` later has no effect either: the configuration was read once.

`config.get(key)` and `config.all()` return the real values: that is their purpose. Pass a secret
only to the code that uses it, and do not log the result of `all()`. When a value does reach a
log line, Knead's [log redaction](/guide/logging/) still masks values under sensitive key names
such as `jwtSecret` and credentials inside URLs, but it cannot recognize a secret stored under an
innocent name.

Two more rules keep secrets out of errors:

- A loader's own error becomes the `cause` of `ConfigLoaderError` unchanged, so a loader must not
  put configuration values in its error messages (the Vault store above names only the path and
  status). The `cause` is non-enumerable, like a native one, so serializers that walk own keys
  skip it.
- Because `Config` freezes the validated output in place, an object you pass in `values` that the
  schema returns unchanged is frozen too.

## Several configuration handles

An application can split its settings across several handles, each registered with its own
`ConfigModule.forRoot()` (or `forRootAsync()`). Every handle reads only its own declared keys, so
two handles can share the environment without seeing each other's settings.

## Schema libraries

`defineConfig()` needs to know which keys the schema declares, so the schema must implement both
[Standard Schema](https://standardschema.dev) (to validate) and Standard JSON Schema
(`~standard.jsonSchema`, to list its properties). The top level must be a plain object schema with
declared properties, not a `$ref`, `allOf` or `anyOf`.

| Library | Minimum version | How to pass it |
| --- | --- | --- |
| Zod | 4.2.0 | `z.object({ ... })` directly |
| ArkType | 2.1.28 | `type({ ... })` directly |
| Valibot | 1.5.0, with `@valibot/to-json-schema` 1.5.0 | `toStandardJsonSchema(v.object({ ... }))` |

A schema without Standard JSON Schema is a `ConfigDefinitionError` at `defineConfig()`:

```text
defineConfig needs a schema that implements Standard JSON Schema (~standard.jsonSchema), such as Zod 4.2+, ArkType 2.1.28+, or Valibot wrapped with toStandardJsonSchema().
```

A schema that cannot be converted to JSON Schema (for example a Zod `bigint` field) fails with
`Could not convert the config schema to JSON Schema.`, the library's error attached as `cause`.

## Testing

`Test.createModule()` from [`@knead-js/testing`](/guide/testing/) boots the real
`ConfigModule`, which reads `process.env`. To make a test independent of the machine it runs on,
replace the handle's provider with a ready `Config`:

<<< config/testing.ts#override title="signup.service.test.ts"

Or keep the real loading and validation, and pass the settings as `values`, which win over the
environment:

<<< config/testing.ts#values title="signup.service.test.ts"

The full API is on the [`@knead-js/config` reference page](/packages/config/).
