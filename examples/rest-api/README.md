# Knead REST API example

A small users API showing CORS, rate limiting, security headers, guards, schema validation and GraphQL working together. Private; not published.

## Run

```bash
pnpm install
pnpm --filter @knead-js/example-rest-api start   # listens on HOST:PORT (default 127.0.0.1:3000)
```

Demo bearer tokens (hard-coded, demo only): `admin-token` (an admin with every permission), `user-token` (a regular user granted `users:read`) and `reader-token` (the admin, but granted only `users:read`). The demo `AuthService` throws at startup when `NODE_ENV=production`. Set `HOST=0.0.0.0` to accept connections from the network. Creating and deleting users needs `create`/`delete` on `User`, which only the admin has, and only through a token granted `users:write`:

```bash
curl -X POST localhost:3000/users -H 'authorization: Bearer admin-token' -H 'content-type: application/json' -d '{"name":"Ada"}'
```

The same users are available over GraphQL at `/graphql`. `createUser` requires the admin token:

```bash
curl -X POST localhost:3000/graphql -H 'content-type: application/json' -d '{"query":"{ users { id name } }"}'
```

## Test

```bash
pnpm --filter @knead-js/example-rest-api test
```

## Notes

The CORS origin `http://localhost:5173` in `src/app.module.ts` is a placeholder for a local front-end; replace it with your real origin(s). Authorization uses `@knead-js/casl` (`src/auth/permissions.ts`): `AuthGuard` authenticates the token (`401` otherwise), then `AbilityGuard` checks the route's `@Can()` against what both the user and the token's grant allow (`403` otherwise). A route guarded by `AbilityGuard` without `@Can()` is denied. The GraphQL `createUser` mutation uses the same rules through `GraphQLModule`'s `guards: [AbilityGuard]`; the public queries are `@SkipAbility()`. Behind a reverse proxy, uncomment `trustProxy` in `src/main.ts`. `src/app.module.ts` spells out the GraphQL limits.
