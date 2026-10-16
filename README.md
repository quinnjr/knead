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

Global middleware runs highest priority first: security headers (1100) wrap CORS (1000), which wraps rate limiting (900), so every response, including preflights and 429s, gets security headers.

See `examples/rest-api` for CORS, rate limiting, security headers, guards and validation working together.

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm build && pnpm test
REDIS_URL=redis://localhost:6379 pnpm test   # include RedisStore tests
```

Work follows git-flow: feature branches from `develop`, squash-merged by pull request.

### Releasing

All `@hpmws/*` packages share one version (Changesets fixed mode). To release:
1. `git flow release start <version>`
2. `pnpm version-packages`
3. `git commit -am "chore: release v<version>"`
4. `git flow release finish <version>` (this tags `v<version>` on `main`)
5. `git push origin main develop --follow-tags`. The tag starts `.github/workflows/release.yml`.

The release workflow has two jobs:
- **build** (read-only token, no OIDC, no dependency cache) refuses the tag unless its commit is on `main` and `v<version>` equals every publishable package's version (`bun scripts/release.ts gate v<version>`). It then runs install, lint, typecheck, test, clean, build and `check:pack`, packs each package (`bun scripts/release.ts pack <dir>`), generates CycloneDX SBOMs with `pnpm sbom`, and uploads the tarballs and SBOMs as workflow artifacts.
- **publish** is the only job with `id-token: write`. It checks out nothing and runs no repo scripts: it downloads the tarballs, checks each one's name and version against the tag, and runs `npm publish <tarball> --access public` with the runner's npm (11.5.1 or newer, required for trusted publishing). Versions already on npm are skipped, so a release that failed part-way can be re-run from the Actions tab. Prereleases (`v1.0.0-next.0`) publish under their identifier's dist-tag (`next`).

To check a release locally without publishing: `bun scripts/release.ts gate v<version>`, then `bun scripts/release.ts pack /tmp/hpmws-tarballs` after `pnpm build`.

CI authenticates to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) rather than a stored token. Each `@hpmws/*` package on npmjs.com must trust this repository's `release.yml` workflow. A new package needs one manual publish first (`pnpm publish --access public --otp <code>` from its directory). After that, register the workflow for every public package while logged in to npm with 2FA: `pnpm trust:npm` (add `--dry-run` to preview). npm attaches provenance only while the repository is public.

The release job does not use a GitHub deployment environment yet, because environments with protection rules are not available to private repositories on the free plan. Once the repository is public (or the plan allows it), add `environment: npm-publish` to the `publish` job, protect that environment with required reviewers and a `v*` tag rule, and re-register the trusted publishers with `pnpm trust:npm --env npm-publish`.

Security issues: see [SECURITY.md](SECURITY.md).

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE) at your option.
