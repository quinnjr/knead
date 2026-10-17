# @knead-js/testing

[![npm](https://img.shields.io/npm/v/@knead-js/testing?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/testing)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

Test Knead applications as they really run: compile a module with providers, guards, middleware
and filters replaced, capture its logs, and send HTTP, GraphQL and WebSocket requests to a real
Bun server on a random local port.

**[Documentation](https://quinnjr.github.io/knead/packages/testing/)** · [Guide](https://quinnjr.github.io/knead/guide/testing/) · [Knead](https://github.com/quinnjr/knead)

## Install

```bash
bun add -d @knead-js/testing
```

Requires Bun 1.4.3 or newer. `@knead-js/core` and `@knead-js/http` are peer dependencies, which
your application already installs (`bun add @knead-js/core @knead-js/http`), so the tests and the
application share one copy of each.

## Quick start

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import { TodosModule } from './todos.module.js';

let moduleRef: TestingModule;
let app: TestApp;

beforeEach(async () => {
  moduleRef = await Test.createModule({ imports: [TodosModule] }).compile();
  app = await moduleRef.createApp();
});

afterEach(() => moduleRef.close());

test('creates and reads a todo', async () => {
  const created = await app.request('POST', '/todos', { json: { title: '  Buy flour ' } });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ id: 1, title: 'Buy flour', done: false });

  const read = await app.request('GET', '/todos/1');
  expect(await read.json()).toEqual({ id: 1, title: 'Buy flour', done: false });
});

test('rejects an empty title', async () => {
  const res = await app.request('POST', '/todos', { json: { title: '' } });
  expect(res.status).toBe(400);
});
```

`compile()` builds the application with `KneadFactory.create()`, running its startup hooks.
`createApp()` starts it on `127.0.0.1` with a random port, and `close()` stops the server and runs
the shutdown hooks.

## Features

- **Real servers.** Requests go through `fetch()` to a listening `Bun.serve`, so routing,
  middleware, guards, validation and filters run exactly as in production.
- **Overrides.** Replace providers, guard classes, middleware classes and filter classes wherever
  they are used, with a value, a class or a factory.
- **Captured logs.** A `MemoryLogger` is the `LOGGER` of every module by default, and its entries
  are on `mod.logs`.
- **Request helpers.** `json` bodies, repeated `query` parameters, headers and raw bodies.
- **GraphQL client.** `app.graphql()` for queries and mutations, `app.graphqlSubscribe()` for
  `graphql-transport-ws` subscriptions.
- **HTTPS.** Test TLS servers with self-signed certificates.

## Overrides

```ts
test('rejects requests without the admin key', async () => {
  mod = await Test.createModule({ imports: [CatalogModule] }).compile();
  const app = await mod.createApp();

  const res = await app.request('POST', '/products', { json: { name: 'Mug' } });

  expect(res.status).toBe(403);
});

test('creates a product when the guard allows it', async () => {
  mod = await Test.createModule({ imports: [CatalogModule] })
    .overrideGuard(AdminGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const app = await mod.createApp();

  const res = await app.request('POST', '/products', {
    json: { name: 'Mug', priceCents: 1200, tags: ['kitchen'] },
  });

  expect(await res.json()).toEqual({
    id: 'p3',
    name: 'Mug',
    priceCents: 1200,
    tags: ['kitchen'],
  });
});
```

| Method | Replaces |
| --- | --- |
| `overrideProvider(token)` | The provider of `token` in every module that registers it (not `multi: true` providers). |
| `overrideGuard(GuardClass)` | A guard class wherever it is referenced. |
| `overrideMiddleware(MiddlewareClass)` | A middleware class wherever it is referenced. |
| `overrideFilter(FilterClass)` | An exception filter class wherever it is referenced. |

Each returns `useValue(value)`, `useClass(cls)` and `useFactory(factory)`; the class and the
factory may `inject()`. An async factory works only for providers. Guards, middleware and filters
passed as instances or functions are not classes and cannot be overridden.

## Development mode and logs

`compile()` runs the application in development mode by default, so a 500 response carries the
error's `detail` and `stack`. Pass `compile({ development: false })` to test what production
clients see: masked errors, and production defaults such as `GraphQLModule` not writing a
`schema.graphql` file.

```ts
test('captures log entries', async () => {
  mod = await Test.createModule({ imports: [CatalogModule] })
    .overrideProvider(ProductsService)
    .useClass(UnavailableProducts)
    .compile();
  const app = await mod.createApp();

  const res = await app.request('GET', '/products');

  expect(res.status).toBe(503);
  expect(mod.logs).toContainEqual({
    level: 'warn',
    message: 'catalog storage unavailable',
    meta: [],
  });
});
```

`mod.logs` holds `{ level, message, meta }` entries exactly as logged, unredacted, because a
`MemoryLogger` is for tests only. `compile({ logger })` takes your own logger instead; either
way it replaces `LoggingModule` and module-local `LOGGER` providers.

## Requests

`app.request(method, path, init?)` sends a request to the test server.

| Option | Description |
| --- | --- |
| `json` | Serialized as the body, with `Content-Type: application/json` unless `headers` sets one. Wins over `body`. |
| `query` | Appended to the query string; an array repeats the parameter. |
| `headers` | Request headers. |
| `body` | A raw body. |
| `tls` | `{ rejectUnauthorized: false }` accepts a self-signed certificate. Tests only. |

`path` is resolved against the server's URL, so an absolute URL would be followed to the host it
names, with the request's headers. Pass paths, never URLs built from untrusted input.

## GraphQL

```ts
test('queries stock over HTTP', async () => {
  // development: false keeps production defaults: masked errors, no schema.graphql written.
  mod = await Test.createModule({ imports: [StockModule] }).compile({ development: false });
  const app = await mod.createApp();

  const res = await app.graphql<{ stock: { quantity: number } | null }>(
    'query Stock($sku: ID!) { stock(sku: $sku) { quantity } }',
    { variables: { sku: 'KETTLE-1' } },
  );

  expect(res.status).toBe(200);
  expect(res.errors).toBeUndefined();
  expect(res.data).toEqual({ stock: { quantity: 12 } });
});
```

`app.graphql()` POSTs `{ query, variables, operationName }` to `/graphql` (or `options.path`) and
returns the parsed body with `status` and `headers`. `app.graphqlSubscribe()` returns an async
iterator of payloads; the server may still be registering the subscription when it resolves, so
publish events until one arrives (the [guide](https://quinnjr.github.io/knead/guide/testing/#subscriptions)
shows a helper).

## Documentation

- [`@knead-js/testing` reference](https://quinnjr.github.io/knead/packages/testing/): every method
  and option.
- [Testing guide](https://quinnjr.github.io/knead/guide/testing/): a complete `bun:test` suite for
  each feature, HTTPS and configuration in tests.

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
