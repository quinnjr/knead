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
- **build** (read-only token, no OIDC, no dependency cache) refuses the tag unless its commit is on `main`, `v<version>` equals every publishable package's version, and every package's `repository` field names this repository and its own directory (`bun scripts/release.ts gate v<version>`). It then runs install, lint, typecheck, test, clean, build and `check:pack`, packs each package (`bun scripts/release.ts pack <dir>`), generates CycloneDX SBOMs with `pnpm sbom`, and uploads the tarballs and SBOMs as workflow artifacts.
- **publish** is the only job with `id-token: write`. It checks out nothing and runs no repo scripts: it downloads the tarballs, checks each one's name and version against the tag, and runs `npm publish <tarball> --access public` with the runner's npm (11.5.1 or newer, required for trusted publishing). Versions already on npm are skipped, so a release that failed part-way can be re-run from the Actions tab. Prereleases (`v1.0.0-rc.0`) publish under their identifier's dist-tag (`rc`); numeric identifiers (`v1.0.0-0`) use `next`.

To check a release locally without publishing: `bun scripts/release.ts gate v<version>`, then `bun scripts/release.ts pack /tmp/hpmws-tarballs` after `pnpm build`. There is no local publish script: releases are published only by `release.yml`.

**What the gate does and does not protect.** A tag runs the `release.yml` *at the tagged commit*. The main-ancestry and version checks therefore stop mistakes (a tag on the wrong branch, a forgotten `pnpm version-packages`), not someone with write access, who can push a tag on a commit whose workflow has no gate at all. That stays true until the publish job runs in a protected GitHub environment and npm only trusts that environment (see below).

> [!WARNING]
> Never push a `v*` tag on a commit that predates the two-job release workflow. Older commits carry the old single-job `release.yml`, which runs every repo script while holding the npm publish credential and has none of these checks.

CI authenticates to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) rather than a stored token. Each `@hpmws/*` package on npmjs.com must trust this repository's `release.yml` workflow. A new package needs one manual publish first (`pnpm publish --access public --otp <code>` from its directory). After that, register the workflow for every public package while logged in to npm with 2FA: `pnpm trust:npm` (add `--dry-run` to preview). npm attaches provenance only while the repository is public.

### Pending until the repository is public

Some protections need features that private repositories on the free plan do not have:
- **Protected release environment.** Once available:
  1. Create a GitHub environment `npm-publish` with required reviewers and a deployment rule allowing only `v*` tags.
  2. Add `environment: npm-publish` to the `publish` job in `release.yml`.
  3. Remove the existing environment-less trusted publisher from every package, so it cannot still be used. List it with `pnpm dlx npm@11.21.0 trust list @hpmws/<pkg>` and remove it with `pnpm dlx npm@11.21.0 trust revoke @hpmws/<pkg> --id=<trust-id>`, or delete it under each package's **Settings → Trusted publishing** on npmjs.com.
  4. Re-register with the environment: `pnpm trust:npm --env npm-publish`.
- **CodeQL.** `codeql.yml` skips its analysis while the repository is private, because code scanning is unavailable there. It starts running automatically once the repository is public (or has GitHub Advanced Security); enable code scanning under **Settings → Code security**.
- **Private vulnerability reporting** (see [SECURITY.md](SECURITY.md)) and **CODEOWNERS enforcement** through branch protection.

Security issues: see [SECURITY.md](SECURITY.md).

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE) at your option.
