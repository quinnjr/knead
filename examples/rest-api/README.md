# hpmws REST API example

A small users API showing CORS, rate limiting, security headers, guards, schema validation and GraphQL working together. Private; not published.

## Run

```bash
pnpm install
pnpm --filter @hpmws/example-rest-api start   # listens on PORT (default 3000)
```

Demo bearer tokens (hard-coded, demo only): `admin-token` and `user-token`. Creating and deleting users requires the admin role:

```bash
curl -X POST localhost:3000/users -H 'authorization: Bearer admin-token' -H 'content-type: application/json' -d '{"name":"Ada"}'
```

The same users are available over GraphQL at `/graphql`. `createUser` requires the admin token:

```bash
curl -X POST localhost:3000/graphql -H 'content-type: application/json' -d '{"query":"{ users { id name } }"}'
```

## Test

```bash
pnpm --filter @hpmws/example-rest-api test
```

## Notes

The CORS origin `http://localhost:5173` in `src/app.module.ts` is a placeholder for a local front-end; replace it with your real origin(s).
