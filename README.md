# hpmws

A NestJS-style framework for [Bun](https://bun.sh): standard TC39 decorators, `inject()`-based dependency injection, schema-typed REST controllers on Bun's native router, and secure-by-default HTTP modules.

| Package | Purpose |
|---|---|
| `@hpmws/core` | DI container, modules, lifecycle hooks |
| `@hpmws/http` | `Bun.serve` adapter, controllers, middleware/guards/filters, TLS, WebSocket registry |
| `@hpmws/cors` | CORS with preflight handling |
| `@hpmws/rate-limit` | Sliding-window / token-bucket limits, memory and Redis stores |
| `@hpmws/security-headers` | CSP (with nonces), HSTS and friends |
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

See `examples/rest-api` for CORS, rate limiting, security headers, guards and validation working together.

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm build && pnpm test
REDIS_URL=redis://localhost:6379 pnpm test   # include RedisStore tests
```

Work follows git-flow: feature branches from `develop`, squash-merged by pull request. To release:
1. `git flow release start <version>`
2. `pnpm version-packages`
3. `git commit -am "chore: release v<version>"`
4. `git flow release finish <version>` (this tags `v<version>`)
5. `git push origin main develop --follow-tags`. CI publishes to npm from the tag.

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE) at your option.
