# @knead-js/config

Typed, validated configuration for the Knead framework. Values come from environment variables,
async loaders (SSM, Vault, files) and code, are validated once at boot with your own schema, and
are injected with `inject()`.

## Install

```bash
pnpm add @knead-js/config
```

`@knead-js/core` is a peer dependency. Bun loads `.env` files itself, so there is no dotenv step.

## Define and use

```ts
import { ConfigModule, defineConfig } from '@knead-js/config';
import { inject, Module } from '@knead-js/core';
import { z } from 'zod';

export const AppConfig = defineConfig(
  z.object({
    port: z.coerce.number().int().default(3000),
    databaseUrl: z.url(),
    jwtSecret: z.string().min(32),
  }),
);

@Module({ imports: [ConfigModule.forRoot(AppConfig)] })
class AppModule {}

class Server {
  readonly config = inject(AppConfig);
  port = this.config.get('port'); // number
}
```

`ConfigModule` is global: any provider can `inject(AppConfig)` without importing it.

Environment variables are always strings, so numbers and booleans need coercion in the schema
(`z.coerce.number()`, not `z.number()`). Otherwise `PORT=3000` fails validation.

## Keys

Environment names are converted from `SCREAMING_SNAKE_CASE` to camelCase, and only keys declared
in the schema are read:

| Environment | Config key |
|---|---|
| `PORT` | `port` |
| `DATABASE_URL` | `databaseUrl` |
| `JWT_SECRET` | `jwtSecret` |

Names that are not `SCREAMING_SNAKE_CASE` (`path`, `Foo_Bar`, `_X`) and names the schema does not
declare are ignored. Two names in the same source that map to the same declared key (for example `X_1` and `X1`, which
both become `x1`) throw `ConfigKeyCollisionError` rather than picking one. Collisions only count
for keys the schema declares.

## Precedence

From lowest to highest: `process.env`, then each loader in order (later loaders win), then the
`values` you pass in code.

```ts
ConfigModule.forRoot(AppConfig, { values: { port: 8080 } });
```

## Schemas

The schema is strict: only keys it declares are read, and `defineConfig` needs the schema's
declared properties to know which keys to look for. That requires Standard JSON Schema
(`~standard.jsonSchema`) support. Verified minimums:

- Zod 4.2.0+
- ArkType 2.1.28+
- Valibot 1.5.0+ with `@valibot/to-json-schema` 1.5.0+, wrapped with `toStandardJsonSchema()`:

```ts
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

const AppConfig = defineConfig(toStandardJsonSchema(v.object({ port: v.pipe(v.string(), v.toNumber()) })));
```

## Async loaders

A loader is a function returning a record of strings (or a promise of one). Use `forRootAsync` and
inject whatever the loader needs in `useFactory`, not in the loader:

```ts
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ConfigModule } from '@knead-js/config';
import { InjectionToken, inject, Module } from '@knead-js/core';

const SSM = new InjectionToken<SSMClient>('SSM');

@Module({
  providers: [{ provide: SSM, useFactory: async () => new SSMClient({}) }],
  exports: [SSM],
})
class AwsModule {}

ConfigModule.forRootAsync(AppConfig, {
  imports: [AwsModule],
  useFactory: () => {
    const client = inject(SSM);
    return {
      loaders: [
        async () => {
          const out: Record<string, string> = {};
          let token: string | undefined;
          do {
            const res = await client.send(
              new GetParametersByPathCommand({
                Path: '/my-app/prod/',
                WithDecryption: true,
                NextToken: token,
              }),
            );
            for (const p of res.Parameters ?? []) {
              if (p.Name && p.Value) out[p.Name.split('/').pop() as string] = p.Value;
            }
            token = res.NextToken;
          } while (token);
          return out; // { DATABASE_URL: '...', JWT_SECRET: '...' }
        },
      ],
    };
  },
});
```

`useFactory` runs inside the injection context, so `inject()` works there. Loaders do not: they
run after an `await`, and calling `inject()` in one fails boot with a `ConfigLoaderError` whose
`cause` is core's `InjectionContextError`. Loaders run concurrently, once, after `useFactory`
settles.

## Errors and secrets

- Errors name keys and sources, never values. `ConfigValidationError` lists each problem as
  `JWT_SECRET (jwtSecret): Missing value` or `Invalid value`.
- `Config` redacts itself: `JSON.stringify(config)` and `console.log(config)` show
  `[redacted]` for every key. `config.get(key)` reads one value and `config.all()` returns the
  whole frozen object; `all()` is the explicit escape hatch, so do not log its result.
- Configuration is loaded once at boot and deep-frozen. Changing `process.env` later has no
  effect, and a validation failure stops boot.

## Testing

```ts
const mod = await Test.createModule({ imports: [ConfigModule.forRoot(AppConfig)] })
  .overrideProvider(AppConfig)
  .useValue(new Config({ port: 1, databaseUrl: 'postgres://x', jwtSecret: 'x'.repeat(32) }))
  .compile();
```
