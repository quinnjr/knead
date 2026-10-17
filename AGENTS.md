# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. Read it before changing
code. The [README](./README.md) covers usage, the release pipeline and toolchain pins in depth.

## What this is

**Knead** is a NestJS-style web framework for [Bun](https://bun.sh), published as the
`@knead-js/*` packages from [`quinnjr/knead`](https://github.com/quinnjr/knead). It uses standard
TC39 decorators (no `experimentalDecorators`, no `reflect-metadata`), `inject()`-based dependency
injection, and is secure by default.

| Path | Package | Role |
|---|---|---|
| `packages/core` | `@knead-js/core` | DI container, modules, lifecycle, metadata |
| `packages/http` | `@knead-js/http` | `Bun.serve` adapter, routing, pipeline, guards, WebSocket registry, logger |
| `packages/config` | `@knead-js/config` | Typed, validated config from env vars, async loaders and code |
| `packages/cors` | `@knead-js/cors` | CORS |
| `packages/rate-limit` | `@knead-js/rate-limit` | Rate limiting (memory and Redis stores) |
| `packages/security-headers` | `@knead-js/security-headers` | CSP, HSTS and other headers |
| `packages/sanitize` | `@knead-js/sanitize` | Allowlist HTML sanitization |
| `packages/schedule` | `@knead-js/schedule` | Cron/interval/timeout jobs, `SchedulerRegistry`, memory and Redis lock stores |
| `packages/prisma` | `@knead-js/prisma` | Prisma 7 integration: `PrismaModule`, ambient transactions, HTTP error mapping, `withRollback` |
| `packages/graphql` | `@knead-js/graphql` | Code-first GraphQL on [Leaven](https://github.com/quinnjr/leaven) |
| `packages/casl` | `@knead-js/casl` | [CASL](https://casl.js.org) authorization: permission catalog, token grants, REST and GraphQL guards |
| `packages/testing` | `@knead-js/testing` | Test modules, overrides, real ephemeral servers |
| `examples/rest-api`, `examples/graphql-server` | private | Reference apps; `graphql-server` has an end-to-end `smoke` script |
| `scripts/` | | Release gate/pack (`release.ts`), `check-pack.ts`, `trust-npm-publishers.sh` |

## Toolchain

- **Bun ≥ 1.4.3** is the runtime and test runner (`bun test`). Use Bun APIs (`Bun.serve`,
  `Bun.redis`, `Bun.CryptoHasher`, `Bun.file`) rather than Node equivalents.
- **pnpm 12** (`packageManager` is pinned with a hash). **Use pnpm only**: never `npm`, `npx` or
  `yarn` for project work (`pnpm add`, `pnpm exec`, `pnpm dlx`). The npm CLI appears only where the
  npm registry requires it (trusted-publisher setup, the CI publish job).
- **TypeScript 7** (`tsc -b` builds, `tsconfig.check.json` typechecks src, tests and scripts).
  ESM with `verbatimModuleSyntax`: relative imports use the `.js` extension, type-only imports use
  `import type`.
- **Biome** for lint and format: 2 spaces, single quotes, semicolons, trailing commas, 100 columns.
  Run `pnpm format` to fix.

## Commands

```bash
pnpm install --frozen-lockfile   # the lockfile is the source of truth
pnpm lint                        # biome check .
pnpm typecheck                   # includes *.test-d.ts type tests
pnpm test                        # every package + scripts/ tests
pnpm clean && pnpm build         # tsc -b
pnpm check:pack                  # packs every package and smoke-tests the tarballs in a consumer app
pnpm --filter @knead-js/example-graphql-server smoke   # runs the real example server end to end
```

Redis-backed suites skip unless `REDIS_URL` is set. Run them before finishing any change that
touches `rate-limit`, `RedisPubSub`, `RedisLockStore` or WebSockets:

```bash
docker run -d --rm -p 6390:6379 redis:7-alpine
REDIS_URL=redis://localhost:6390 pnpm test
REDIS_URL=redis://localhost:6390 pnpm --filter @knead-js/example-graphql-server smoke
```

The Postgres suite of `@knead-js/prisma` skips unless `KNEAD_PRISMA_TEST_DATABASE_URL` is set
(a dedicated variable, never `DATABASE_URL`, so an application's real database is never the
target). Run it before finishing changes to `packages/prisma`:

```bash
docker run -d --rm --name knead-prisma-pg -p 5433:5432 -e POSTGRES_PASSWORD=knead postgres:17-alpine
KNEAD_PRISMA_TEST_DATABASE_URL=postgresql://postgres:knead@localhost:5433/postgres pnpm --filter @knead-js/prisma test:db
```

`test:db` exits early when `KNEAD_PRISMA_TEST_DATABASE_URL` is unset. It uses
`prisma db push --force-reset`, which Prisma refuses to run from AI agents without
the user's consent. Agents should either ask the user to run it, or, on a freshly started
container only, run `prisma generate` and a plain `prisma db push` with the fixture config
(`--config test/fixtures/prisma.config.ts`), then `bun test`. Agents must never set
`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` themselves.

**Definition of done:** `pnpm lint && pnpm typecheck && pnpm test && pnpm clean && pnpm build &&
pnpm check:pack`, plus the smoke script, plus the Redis runs above when relevant, all green.

## Workflow

- **Git flow.** Branch from `develop` (`feature/…`, `fix/…`, `chore/…`, `docs/…`); hotfixes from
  `main`; releases on `release/<version>`. Never commit, merge or push directly to `develop` or
  `main`: changes land through reviewed pull requests, squash-merged. Back-merges (`main` →
  `develop`) use a merge commit.
- **Worktrees** live under `.worktrees/` (git-ignored via `.git/info/exclude`).
- **Conventional Commits** (`feat(http): …`, `fix(graphql): …`, `refactor!: …`). Keep commits atomic.
- **Changesets.** Every change to a published package needs a `.changeset/*.md` (all packages are
  one fixed version group; `minor` for features and breaking changes while below 1.0, `patch` for
  fixes). Releases run `pnpm version-packages` on a release branch.
- **Never commit** `docs/superpowers/**` (design specs and plans are kept out of the repo).
- **Test first.** Add a failing test that reproduces a bug or pins a behaviour before changing
  code. Type-level guarantees get `*.test-d.ts` cases (`// @ts-expect-error`). Performance and DoS
  fixes get timing tests on pathological input.
- **Follow-ups are not deferred.** Review findings (including minor ones), TODOs you touch and test
  gaps are fixed in the same branch, not left as notes.

## Conventions

- **DI and decorators.** Providers are classes using `inject(Token)` in field initializers;
  modules use `@Module({ imports, providers, controllers, exports })`. Metadata lives under
  `knead:`-prefixed keys via `@knead-js/core`'s metadata helpers; don't use `reflect-metadata`.
- **Namespaces.** Every string namespace is `knead:` (metadata keys, Redis prefixes `knead:rl:` and
  `knead:gql:`, logger names). Keep new ones consistent.
- **Errors.** Throw the `HttpException` subclasses from `@knead-js/http`; configuration problems
  are `HttpConfigError`/`KneadError` raised at bootstrap or `listen()`, never at request time.
- **Logging.** Log through the injected `LOGGER` and the shared error-log helper, never
  `console.*` directly. Never log a raw error object outside development; redact before logging.
- **Dependencies.** Keep the runtime dependency tree minimal. Security-relevant or provenance-less
  dependencies are pinned exactly (Leaven, `sanitize-html`, `dataloader`, `@casl/ability`).
  Adding a dependency to a published package also means updating `ALLOWED_DEPENDENCIES` in
  `.github/workflows/release.yml` (a test enforces this).

## Security invariants

Knead has been through two full security audits. Treat these as invariants; changing one needs a
deliberate decision and tests:

- **Fail closed.** Guards pass only on `=== true`. Development mode, introspection, the playground
  and unmasked errors are on only when `NODE_ENV === 'development'` (or the app's development
  flag).
- **Default limits stay on**: request body size, query/form parameter counts, GraphQL depth,
  complexity, tokens, fields and aliases, WebSocket payload size, message rate and connections per
  IP. New input paths need their own bounds.
- **Untrusted input.** Query, form and JSON objects drop `__proto__`/`constructor`/`prototype`;
  never `Object.assign` request data onto objects. Hosts, origins and `X-Forwarded-*` values are
  validated before use (`allowedHosts`, same-origin WebSocket checks, `trustProxy`).
- **Secrets.** Credentials never reach logs or responses: redaction covers URL userinfo,
  `key=value` secrets, Bearer/Basic and nested objects. Error messages to clients are masked in
  production.
- **Regexes and parsers** must be linear on adversarial input; add a timing test.
- **Release pipeline.** The publish job holds the only OIDC credential, runs no repository code, and
  verifies every tarball with npm's own parsers before publishing. Don't add steps that execute repo
  code or third-party actions there. Every `uses:` is pinned to a full commit SHA.
- Report vulnerabilities per [SECURITY.md](./SECURITY.md), not in public issues.

## Releasing

Version on a `release/<version>` branch (`pnpm version-packages`), merge it to `main` by PR, tag
`v<version>` on `main`'s HEAD, then back-merge `main` → `develop`. The tag triggers
`release.yml`, which publishes through npm trusted publishing (OIDC). See the README's
"Releasing" section for the gates and the one-time trusted-publisher setup.
