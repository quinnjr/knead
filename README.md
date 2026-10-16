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

Examples (private workspace packages, not published):

| Example | Shows |
| --- | --- |
| [`examples/rest-api`](examples/rest-api) | CORS, rate limiting, security headers, guards, validation and a GraphQL endpoint working together |
| [`examples/graphql-server`](examples/graphql-server) | A GraphQL blog using every package: interfaces, unions, enums, a custom scalar, DataLoaders, auth guards and roles, subscriptions on in-memory or Redis pub/sub, plus a REST route and an end-to-end smoke test (`pnpm --filter @hpmws/example-graphql-server smoke`) |

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm build && pnpm test
REDIS_URL=redis://localhost:6379 pnpm test   # include RedisStore and RedisPubSub tests
```

Work follows git-flow: feature branches from `develop`, squash-merged by pull request.

CI also scans the full git history for committed secrets with a pinned, checksum-verified [gitleaks](https://github.com/gitleaks/gitleaks) (the `secrets` job in `ci.yml`). Known fakes (the RFC 6455 WebSocket sample key, the example apps' demo tokens and the redaction test fixtures) are allowlisted in `.github/gitleaks.toml`. To run it locally: `gitleaks git --config .github/gitleaks.toml --redact .`

### Releasing

All `@hpmws/*` packages share one version (Changesets fixed mode). To release:
1. `git flow release start <version>`
2. `pnpm version-packages`
3. `git commit -am "chore: release v<version>"`
4. `git flow release finish <version>` (this tags `v<version>` on `main`)
5. `git push origin main develop --follow-tags`. The tag starts `.github/workflows/release.yml`.

The release workflow has two jobs:
- **build** (read-only token, no OIDC, no dependency cache) refuses the tag unless its commit is on `main`, `v<version>` equals every publishable package's version both in the tagged commit and at the head of `origin/main` (so an older main commit cannot be released), and every package's `repository` field names this repository and its own directory (`bun scripts/release.ts gate v<version>`). It then runs install, `pnpm audit --audit-level=high` (all dependencies, not only production ones, because the dev toolchain builds the artifact), lint, typecheck, test (with the same digest-pinned Redis service as CI, so the Redis suites run on the build that ships), clean, build and `check:pack`, packs each package (`bun scripts/release.ts pack <dir>`), writes `SHA256SUMS` over the tarballs, generates CycloneDX SBOMs with `pnpm sbom` (production SBOMs per package plus `toolchain-*` SBOMs that include dev dependencies), and uploads the tarballs with `SHA256SUMS` and the SBOMs as workflow artifacts. The digest of `SHA256SUMS` is passed to the publish job as a job output, outside the artifact store.
- **publish** is the only job with `id-token: write`. It checks out nothing and runs no repo scripts: it downloads the tarballs and verifies all of them before publishing any. `SHA256SUMS` must match the digest the build job reported, list exactly the tarballs present, and match every tarball. Each tarball must be at most 10 MiB and unpack to at most 64 MiB (checked before any parser reads it, so a gzip bomb cannot exhaust the job), its `package.json` at most 1 MiB, and it must hold exactly one `package/package.json` and nothing but `package.json`, `README.md`, `LICENSE-MIT`, `LICENSE-APACHE` and regular files under `dist/` (no symlinks). Because `npm publish` reads the tarball with node-tar and pacote rather than GNU tar, each tarball is also parsed with the node-tar and pacote bundled with the job's npm: both must list exactly the entries GNU tar lists, pacote's manifest must equal the `package/package.json` GNU tar extracts, and a raw header walk rejects anything the parsers could resolve differently (GNU sparse records, PAX records other than a `path` equal to the header name and timestamps/owners, entry types other than file and directory, data after the end-of-archive marker). The remaining manifest checks run on pacote's manifest. The package name must be one of the eight names hard-coded in `ALLOWED_PACKAGES` in `release.yml` (exact match; `scripts/release.test.ts` keeps the list equal to the workspace's publishable packages), and every one of them must be in the artifact exactly once, so a partial set is never published, the version must equal the tag, its `dependencies`, `optionalDependencies` and `peerDependencies` may only name what `ALLOWED_DEPENDENCIES` in `release.yml` lists for that package (kept equal to the workspace manifests by `scripts/release.test.ts`, so adding a dependency means updating that list in the same pull request), and the manifest may not set `publishConfig` beyond `access`, lifecycle scripts (`pre*`, `post*`, `install`, `prepare`, `publish`, ...) or bundled dependencies. Before publishing anything it also checks that every package already exists on npm (`npm view <name> name`): a brand-new package has no trusted publisher yet, so the run stops and points at the manual first publish and `pnpm trust:npm` below instead of publishing a partial release. It then runs `npm publish <tarball> --access public --ignore-scripts --registry=https://registry.npmjs.org/` with the runner's npm (11.5.1 or newer, required for trusted publishing). Versions already on npm are skipped, so a release that failed part-way can be re-run from the Actions tab. A stable version takes the `latest` dist-tag only when it is newer than the package's current `latest`; an older line (a backport such as `v1.2.4` after `v1.3.0`) is published under `v<major>.<minor>-latest` (`v1.2-latest`). Prereleases (`v1.0.0-rc.0`) publish under their identifier's dist-tag (`rc`); numeric identifiers (`v1.0.0-0`) use `next`.

To check a release locally without publishing: `bun scripts/release.ts gate v<version>` (after `git fetch origin`; pass a ref as a third argument to compare against something other than `origin/main`), then `bun scripts/release.ts pack /tmp/hpmws-tarballs` after `pnpm build`. There is no local publish script: releases are published only by `release.yml`.

**What the gate does and does not protect.** A tag runs the `release.yml` *at the tagged commit*. The main-ancestry and version checks therefore stop mistakes (a tag on the wrong branch, a forgotten `pnpm version-packages`), not someone with write access, who can push a tag on a commit whose workflow has no gate at all. That stays true until the publish job runs in a protected GitHub environment and npm only trusts that environment (see below).

> [!WARNING]
> Never push a `v*` tag on a commit that predates the two-job release workflow. Older commits carry the old single-job `release.yml`, which runs every repo script while holding the npm publish credential and has none of these checks.

CI authenticates to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) rather than a stored token. Each `@hpmws/*` package on npmjs.com must trust this repository's `release.yml` workflow. A new package needs one manual publish first (`pnpm publish --access public --otp <code>` from its directory). After that, register the workflow for every public package while logged in to npm with 2FA: `pnpm trust:npm` (add `--dry-run` to preview). The script logs in if needed and always logs out of npm when it exits, even on failure, so no long-lived npm session token stays in `~/.npmrc`; that also ends any session you had before running it. npm attaches provenance only while the repository is public.

### Toolchain and image pins

Dependabot updates npm dependencies and the SHA-pinned GitHub Actions, but not the versions written into the workflows, so these are bumped by hand:
- **Redis service image** (`ci.yml` and `release.yml`, pinned by digest): monthly, and as soon as a Redis security release ships. Get the current digest with `docker buildx imagetools inspect redis:7-alpine` (the top-level index digest) and update both files together.
- **Node** (`NODE_VERSION`) and **Bun** (`BUN_VERSION` plus `BUN_REVISION`, the output of `bun --revision` for that release) in both workflows: on every Node 24 LTS security release and every Bun release that fixes a security issue, otherwise monthly. Get `BUN_REVISION` by running the new Bun locally, and keep the `engines.bun` floor in sync.
- **gitleaks** (`GITLEAKS_VERSION` and `GITLEAKS_SHA256` in `ci.yml`): quarterly; take the sha256 of `gitleaks_<version>_linux_x64.tar.gz` from the release's `checksums.txt`.
- **pnpm** (`packageManager` in `package.json`, with its `+sha512.<hex>` integrity, the registry's `dist.integrity` converted from base64 to hex).

### Pending until the repository is public

Some protections need features that private repositories on the free plan do not have:
- **Protected release environment.** Once available:
  1. Create a GitHub environment `npm-publish` with required reviewers and a deployment rule allowing only `v*` tags.
  2. Add `environment: npm-publish` to the `publish` job in `release.yml`.
  3. Remove the existing environment-less trusted publisher from every package, so it cannot still be used. List it with `pnpm dlx npm@11.21.0 trust list @hpmws/<pkg>` and remove it with `pnpm dlx npm@11.21.0 trust revoke @hpmws/<pkg> --id=<trust-id>`, or delete it under each package's **Settings → Trusted publishing** on npmjs.com.
  4. Re-register with the environment: `pnpm trust:npm --env npm-publish`.
- **CodeQL.** `codeql.yml` skips its analysis until the repository variable `CODEQL_ENABLED` is `true`, because code scanning is unavailable on a private free-plan repository. When the repository goes public (or gets GitHub Advanced Security), enable code scanning under **Settings → Code security** and set the variable under **Settings → Secrets and variables → Actions → Variables** (`gh variable set CODEQL_ENABLED --body true`).
- **Private vulnerability reporting** (see [SECURITY.md](SECURITY.md)) and **CODEOWNERS enforcement** through branch protection.

Security issues: see [SECURITY.md](SECURITY.md).

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE) at your option.
