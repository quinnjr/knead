# Knead GraphQL server example

A small blog (authors, posts and comments, kept in memory and seeded at startup) served over GraphQL with every Knead package working together: code-first types, DataLoader-batched field resolvers, valibot argument validation, bearer-token auth with resolver guards and role metadata, subscriptions over `graphql-transport-ws` (in memory or on Redis), CORS, rate limiting, security headers and HTML sanitization, plus a plain REST `GET /health` route next to `/graphql` that returns only `{ "status": "ok" }`. Private; not published.

## Run

```bash
pnpm install
pnpm --filter @knead-js/example-graphql-server dev     # NODE_ENV=development, watches src/
pnpm --filter @knead-js/example-graphql-server start   # production defaults
```

| Variable | Default | Effect |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listening address; set `0.0.0.0` to accept connections from the network (for example in a container) |
| `PORT` | `3000` | Listening port |
| `NODE_ENV` | | `development` turns on the playground, introspection and unmasked errors, and writes `schema.graphql`. `production` refuses to start: the demo tokens are public |
| `REDIS_URL` | | Use `RedisPubSub` for subscriptions, so several instances share events |
| `REDIS_PUBSUB_SIGNING_KEY` | | `RedisPubSub` `signingKey` (generate with `openssl rand -base64 32`): events are signed, and unsigned or forged ones are dropped. Required with `REDIS_URL` under `NODE_ENV=production` (the server refuses to start without it) |
| `REDIS_PUBSUB_ENCRYPTION_KEY` | | `RedisPubSub` `encryptionKey` (generate with `openssl rand -base64 32`): event payloads are AES-256-GCM encrypted in Redis |
| `RATE_LIMIT_HASH_SECRET` | | With `REDIS_URL`, share rate limits through `RedisStore`, with keys HMAC-hashed under this secret (`openssl rand -base64 32`, the same on every instance) so client IPs cannot be recovered from Redis |
| `RATE_LIMIT` | `100` | Requests per client IP per minute (`/health` is exempt) |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated browser origins for CORS and subscription sockets |

In development, open <http://localhost:3000/graphql> in a browser for the playground. Development runs also write the schema SDL to `schema.graphql` (gitignored).

Demo bearer tokens (hard-coded and public, demo only; the demo `AuthService` throws at startup when `NODE_ENV=production`):

| Token | User | Roles |
| --- | --- | --- |
| `ada-token` | Ada Lovelace (`a1`) | `admin` |
| `grace-token` | Grace Hopper (`a2`) | none |

## Queries

```bash
# Plain REST
curl localhost:3000/health

# Published posts with their authors (one batched author lookup for the whole list)
curl localhost:3000/graphql -H 'content-type: application/json' \
  -d '{"query":"{ posts(status: PUBLISHED, first: 10) { id title publishedAt author { name } } }"}'

# DateTime argument, union search and the Node interface
curl localhost:3000/graphql -H 'content-type: application/json' \
  -d '{"query":"{ posts(since: \"2026-03-01T00:00:00Z\") { title createdAt } search(term: \"an\") { __typename ... on Post { title } ... on Author { name } } node(id: \"a2\") { __typename id } }"}'

# GET runs queries only, and needs a CSRF header
curl -G localhost:3000/graphql -H 'x-graphql-request: 1' --data-urlencode 'query={ authors { name } }'
```

## Mutations

Drafts are visible only to their author and to admins: everyone else sees published posts only, and someone else's draft is reported as not found (`post`, `node`, `Author.posts`, `addComment`, `publishPost` and the `commentAdded` subscription alike). Every mutation needs a token (`UNAUTHENTICATED` otherwise). `deletePost` is admin-only (`FORBIDDEN` for `grace-token`): `RolesGuard` reads `@Roles()` through `ctx.meta` and passes only a signed-in user holding one of the roles, and it also denies a resolver that uses it without `@Roles()`.

```bash
curl localhost:3000/graphql -H 'content-type: application/json' -H 'authorization: Bearer grace-token' \
  -d '{"query":"mutation($i: CreatePostInput!) { createPost(input: $i) { id title body status } }",
       "variables":{"i":{"title":"Compilers","body":"<p>Hi</p><script>alert(1)</script>","publish":true}}}'

curl localhost:3000/graphql -H 'content-type: application/json' -H 'authorization: Bearer grace-token' \
  -d '{"query":"mutation { addComment(postId: \"p1\", body: \"<em>Great</em>\") { id body } }"}'

curl localhost:3000/graphql -H 'content-type: application/json' -H 'authorization: Bearer ada-token' \
  -d '{"query":"mutation { deletePost(id: \"p4\") }"}'
```

`createPost` input is validated with valibot (a 3-character title fails with `BAD_USER_INPUT` and `extensions.issues`), and post and comment bodies are sanitized with `@knead-js/sanitize`.

## Subscriptions

`postPublished(authorId: ID)` and `commentAdded(postId: ID!)` run over a `graphql-transport-ws` WebSocket on `/graphql`. Browsers cannot send an `Authorization` header on a WebSocket, so the token goes in `connectionParams`; a missing or unknown token closes the socket with `4403`. `commentAdded` rechecks its guards before every comment, and `subscriptions.refreshContext` re-verifies the connection's token with a live `AuthService` lookup first, so revoking a token (`AuthService.revoke`) ends the subscription with `FORBIDDEN` at its next event.

In the playground (development), set the connection params to `{ "token": "grace-token" }` and run:

```graphql
subscription {
  postPublished(authorId: "a2") { title author { name } }
}
```

Then publish a post as Grace with the `createPost` curl above (with `"publish": true`). Posts by other authors are filtered out. Events may come through Redis, a trust boundary, so the subscriptions drop malformed events (for example a post whose `status` is not a `PostStatus`) in their `filter`, and `revivePost`/`reviveComment` sanitize the body again before it is sent.

From a terminal, with [`websocat`](https://github.com/vi/websocat):

```bash
websocat -n --protocol graphql-transport-ws ws://localhost:3000/graphql
{"type":"connection_init","payload":{"token":"grace-token"}}
{"id":"1","type":"subscribe","payload":{"query":"subscription { commentAdded(postId: \"p1\") { body author { name } } }"}}
```

Run the `addComment` curl above in another terminal to see the event. `commentAdded` uses `recheckGuards: true`, so the post's visibility is checked again before every comment and the subscription ends with an error once the subscriber can no longer see the post (for example after `deletePost`). Events are published as DTOs with explicit fields (`blog.events.ts`), never as entities, and `revivePost`/`reviveComment` copy only the known fields back. To share events between instances, start each with `REDIS_URL=redis://localhost:6379`.

## Test

```bash
pnpm --filter @knead-js/example-graphql-server test    # @knead-js/testing: app.graphql / app.graphqlSubscribe
pnpm --filter @knead-js/example-graphql-server smoke   # starts the real server and checks it over the network
REDIS_URL=redis://localhost:6379 pnpm --filter @knead-js/example-graphql-server smoke   # with RedisPubSub
```

The smoke test (`scripts/smoke.ts`) spawns `bun src/main.ts` on a free port with `NODE_ENV=development` and `RATE_LIMIT=40`. It checks `/health` (which returns only `{ "status": "ok" }`) and the PubSub engine the server reports at startup, queries, authenticated mutations, the playground and its CSP, security headers, a CORS preflight, a subscription event triggered by a mutation over HTTP, the depth limit, a dropped connection for an oversized WebSocket message, a 429 after the rate limit, and a 403 for a cross-origin or `Origin: null` WebSocket upgrade. The server has no WebSocket endpoint besides `/graphql`, so the origin checks run there. It prints a `PASS`/`FAIL` line per check and exits nonzero on any failure.

## Notes

The CORS origin `http://localhost:5173` is a placeholder for a local front-end; set `CORS_ORIGINS` to your real origin(s). Behind a reverse proxy, uncomment `trustProxy` in `src/main.ts` (the number of proxy hops, or the proxy's CIDRs) so rate limiting sees client IPs. `src/app.module.ts` spells out the GraphQL limits (`maxDepth`, `maxComplexity`, `maxAliases`, `maxQueryLength`, `parseOptions.maxTokens`); raise them deliberately rather than disabling them.
