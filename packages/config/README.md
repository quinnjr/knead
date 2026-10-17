# @knead-js/config

[![npm](https://img.shields.io/npm/v/@knead-js/config?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/config)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

Typed, validated configuration for [Knead](https://github.com/quinnjr/knead) applications. You
describe your settings with a schema; they are loaded from environment variables, async loaders
and code once at startup, validated, and injected anywhere with `inject()`.

**[Documentation](https://quinnjr.github.io/knead/packages/config/)** · [Guide](https://quinnjr.github.io/knead/guide/configuration/) · [Knead](https://github.com/quinnjr/knead)

## Install

```bash
bun add @knead-js/core @knead-js/config valibot @valibot/to-json-schema
```

Requires Bun 1.4.3 or newer. `@knead-js/core` is a peer dependency. You also need a schema library
with Standard JSON Schema support: Zod 4.2+, ArkType 2.1.28+, or Valibot 1.5+ with
`@valibot/to-json-schema` 1.5+ (the examples use Valibot).

## Quick start

Declare every setting in one object schema:

```ts
import { defineConfig } from '@knead-js/config';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

export const AppConfig = defineConfig(
  toStandardJsonSchema(
    v.object({
      // Environment variables are strings: parse numbers and booleans in the schema.
      port: v.optional(v.pipe(v.string(), v.toNumber(), v.integer()), '3000'),
      databaseUrl: v.pipe(v.string(), v.url()),
      jwtSecret: v.pipe(v.string(), v.minLength(32)),
      signupsOpen: v.optional(
        v.pipe(
          v.picklist(['true', 'false']),
          v.transform((value) => value === 'true'),
        ),
        'false',
      ),
    }),
  ),
  { name: 'AppConfig' },
);
```

Register it once, in the root module:

```ts
import { ConfigModule } from '@knead-js/config';
import { Module } from '@knead-js/core';
import { AppConfig } from './app-config.js';
import { SignupService } from './signup.service.js';

@Module({
  imports: [ConfigModule.forRoot(AppConfig)],
  providers: [SignupService],
})
export class AppModule {}
```

`ConfigModule` is global, so any provider can inject the handle and read typed values:

```ts
import { inject } from '@knead-js/core';
import { AppConfig } from './app-config.js';

export class SignupService {
  readonly #config = inject(AppConfig);

  isOpen(): boolean {
    return this.#config.get('signupsOpen'); // boolean, parsed from 'true' or 'false'
  }

  port(): number {
    return this.#config.get('port'); // number, 3000 when PORT is unset
  }
}
```

With `DATABASE_URL` and `JWT_SECRET` set (Bun loads `.env` files itself), the application boots
and `port()` returns `3000`. A missing or invalid value rejects `KneadFactory.create()`, so the
server never starts with a broken configuration.

## Features

- **Typed values.** `config.get(key)` returns the schema's output type; an undeclared key is a
  compile error.
- **Your schema library.** Zod, ArkType or Valibot, through Standard Schema and Standard JSON
  Schema.
- **Validated once, at boot.** Every source is merged and validated before any `onModuleInit` hook
  runs. The result is deep-frozen.
- **Environment names.** `DATABASE_URL` becomes `databaseUrl`; only keys the schema declares are
  read.
- **Async loaders.** Fetch from a secret store or a file at startup, with dependencies injected.
- **Secrets stay secret.** Errors name variables and keys, never values, and `Config` prints as
  `[redacted]`.

## Environment variable names

Each source's names are converted from `SCREAMING_SNAKE_CASE` to camelCase, and only names that
convert to a declared key are read:

| Environment variable | Config key |
| --- | --- |
| `PORT` | `port` |
| `DATABASE_URL` | `databaseUrl` |
| `OAUTH2_CLIENT_ID` | `oauth2ClientId` |

- Names that are not `SCREAMING_SNAKE_CASE` (`path`, `Foo_Bar`, `_PORT`) are ignored, and so are
  names the schema does not declare.
- Two names in one source that map to the same declared key throw `ConfigKeyCollisionError`
  rather than picking one.
- Schema keys must be camelCase that an environment name converts to: `defineConfig()` rejects
  `DATABASE_URL` or `api_key` with a `ConfigDefinitionError` that suggests `databaseUrl` or
  `apiKey`.

Environment variables are strings, so parse numbers and booleans in the schema, as the quick start
does. A schema that expects `v.number()` rejects every value an environment variable can hold.

## Sources and precedence

From lowest to highest precedence:

1. `process.env`
2. each loader, in order (later loaders win)
3. `values` passed in code

Code values are schema input, like environment strings:

```ts
import { ConfigModule } from '@knead-js/config';
import { Module } from '@knead-js/core';
import { AppConfig } from './app-config.js';

@Module({
  imports: [
    // Code values are schema input, like environment strings, and win over every other source.
    ConfigModule.forRoot(AppConfig, { values: { port: '8080', signupsOpen: 'true' } }),
  ],
})
export class AppModule {}
```

A loader is a function returning a record of `SCREAMING_SNAKE_CASE` names and strings, or a
promise of one. Loaders run concurrently, once, outside the injection context. When a loader needs
another provider, use `forRootAsync()` and call `inject()` in `useFactory`, not in the loader:

```ts
export const ShopConfigModule = ConfigModule.forRootAsync(AppConfig, {
  imports: [SecretsModule],
  useFactory: () => {
    // useFactory runs in the injection context: inject() here, not inside a loader.
    const store = inject(SECRET_STORE);
    return { loaders: [() => store.read('shop/production')] };
  },
});

@Module({ imports: [ShopConfigModule] })
export class AppModule {}
```

`loadConfig(handle, sources?, env?)` runs the same loading step outside a module, for example in a
migration script.

## Errors and secrets

A failed validation lists every problem, one line per key, and never the values:

```text
Config validation failed:
  PORT (port): Invalid value
  DATABASE_URL (databaseUrl): Missing value
  JWT_SECRET (jwtSecret): Invalid value
```

- The schema's own messages are discarded, because they can quote the rejected input. A schema
  that throws fails with `Config schema threw while validating.` and its error is dropped.
- A loader's error becomes the `cause` of `ConfigLoaderError` unchanged, so a loader must not put
  configuration values in its error messages.
- `JSON.stringify(config)`, `console.log(config)` and `Bun.inspect(config)` show `[redacted]` for
  every key.
- `config.all()` returns the whole object with every secret: do not log it.
- Configuration is read once. Changing `process.env` later has no effect.

## Testing

Replace the handle's provider with a ready `Config`, so a test does not depend on the machine's
environment:

```ts
test('signups follow the signupsOpen flag', async () => {
  mod = await Test.createModule({
    imports: [ConfigModule.forRoot(AppConfig)],
    providers: [SignupService],
  })
    .overrideProvider(AppConfig)
    .useValue(
      new Config({
        port: 3000,
        databaseUrl: 'postgres://localhost/shop_test',
        jwtSecret: 'test-secret-that-is-at-least-32-chars',
        signupsOpen: true,
      }),
    )
    .compile();

  expect(mod.get(SignupService).isOpen()).toBe(true);
});
```

## Documentation

- [`@knead-js/config` reference](https://quinnjr.github.io/knead/packages/config/): every export,
  option and error class.
- [Configuration guide](https://quinnjr.github.io/knead/guide/configuration/): sources, loaders,
  validation errors, secrets and schema libraries, with examples.
- [Testing guide](https://quinnjr.github.io/knead/guide/testing/): test modules and provider
  overrides.

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
