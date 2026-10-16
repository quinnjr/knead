# hpmws

A NestJS-style framework for [Bun](https://bun.sh): standard TC39 decorators, `inject()`-based dependency injection, schema-typed REST controllers on Bun's native router, and secure-by-default HTTP modules.

| Package | Purpose |
|---|---|
| `@hpmws/core` | DI container, modules, lifecycle hooks |
| `@hpmws/http` | `Bun.serve` adapter, controllers, middleware/guards/filters, TLS, WebSocket registry |
| `@hpmws/cors` | CORS with preflight handling |
| `@hpmws/rate-limit` | Sliding-window / token-bucket limits, memory and Redis stores |
| `@hpmws/security-headers` | CSP (with nonces), HSTS and friends |
| `@hpmws/graphql` | Code-first GraphQL on Leaven: typed decorators, DataLoader, subscriptions |
| `@hpmws/sanitize` | Opt-in allowlist HTML sanitization as a Standard Schema |
| `@hpmws/testing` | `Test.createModule`, overrides, real ephemeral servers |

Requires Bun ≥ 1.4. No `experimentalDecorators`, no `reflect-metadata`.

```ts
import { Module, inject } from '@hpmws/core';
import { Controller, type Ctx, Get, HpmwsFactory } from '@hpmws/http';

class Greeter {
  greet(name: string) {
    return `hello ${name}`;
  }
}

@Controller('/greet')
class GreetController {
  readonly greeter = inject(Greeter);

  @Get('/:name')
  greet({ params }: Ctx<{ params: { name: string } }>) {
    return { message: this.greeter.greet(params.name) };
  }
}

@Module({ controllers: [GreetController], providers: [Greeter] })
class AppModule {}

const app = await HpmwsFactory.create(AppModule);
await app.listen({ port: 3000 });
```

Global middleware runs highest priority first: security headers (1100) wrap CORS (1000), which wraps rate limiting (900), so every response, including preflights and 429s, gets security headers.

See `examples/rest-api` for CORS, rate limiting, security headers, guards, validation and a GraphQL endpoint working together.

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm build && pnpm test
REDIS_URL=redis://localhost:6379 pnpm test   # include RedisStore and RedisPubSub tests
```

Work follows git-flow: feature branches from `develop`, squash-merged by pull request. To release:
1. `git flow release start <version>`
2. `pnpm version-packages`
3. `git commit -am "chore: release v<version>"`
4. `git flow release finish <version>` (this tags `v<version>`)
5. `git push origin main develop --follow-tags`. CI publishes to npm from the tag.

CI authenticates to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) rather than a stored token. Each `@hpmws/*` package on npmjs.com must trust this repository's `release.yml` workflow. A new package needs one manual publish first (`pnpm publish --access public --otp <code>` from its directory). After that, register the workflow for every public package while logged in to npm with 2FA: `pnpm trust:npm` (add `--dry-run` to preview).

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE) at your option.
