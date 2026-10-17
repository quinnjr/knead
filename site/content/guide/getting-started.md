---
title: Getting started
description: Build a small REST API with a module, a service, a validated controller and a test, then run it.
---

This walkthrough builds a todo API: a service that holds the data, a controller that exposes it
over HTTP with validated input, a module that ties them together, and a test that runs against a
real server.

## Install

Create a project and add the packages. Knead needs Bun 1.4.3 or newer.

```bash
mkdir todos && cd todos
bun init -y
bun add @knead-js/core @knead-js/http valibot
bun add -d @knead-js/testing
```

[Valibot](https://valibot.dev) validates the request body here. Any library that implements
[Standard Schema](https://standardschema.dev) works, for example Zod or ArkType.

## Configure TypeScript

Knead uses standard TC39 decorators. Make sure `experimentalDecorators` is **not** enabled in
`tsconfig.json`. Bun reads that setting too: with it on, Bun applies legacy decorators and the
first decorated class fails at load with
`TypeError: undefined is not an object (evaluating 'context.metadata')`.

A configuration that works (the one Knead itself uses):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "ESNext.Decorators"],
    "types": ["bun"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`ESNext.Decorators` provides the type of `Symbol.metadata`. `bun init` installs `@types/bun`,
which provides `"types": ["bun"]`.

## Write a service

A provider is a plain class. This one keeps todos in memory. When a todo is missing, it throws
`NotFoundException`, which Knead turns into a `404` response.

<<< start/todos.service.ts title="src/todos.service.ts"

## Write a controller

`@Controller('/todos')` sets the path prefix. Each route decorator takes a path and an options
object. Route options can carry [Standard Schema](/guide/validation/) validators for `params`,
`query`, `headers` and `body`, plus a success `status`.

<<< start/todos.controller.ts title="src/todos.controller.ts"

Things to notice:

- `inject(TodosService)` in a field initializer asks the injector for the service. Providers are
  singletons by default, so every class that injects `TodosService` gets the same instance.
- The handler receives the request context. `Ctx<{ body: ... }>` types `ctx.body` as the
  schema's **output**: the title is already trimmed, and `params.id` is already a number,
  because the `TodoId` schema transforms it.
- Returning an object or an array sends JSON with status `200` (or the route's `status`).
  Returning nothing sends `204 No Content`.

## Group it in a module

<<< start/todos.module.ts title="src/todos.module.ts"

The root module imports feature modules:

<<< start/app.module.ts title="src/app.module.ts"

## Start the server

<<< start/main.ts title="src/main.ts"

```bash
bun src/main.ts
```

```text
[knead] Listening on http://127.0.0.1:3000/
```

`listen()` binds port `3000` on `0.0.0.0` (every interface) by default. This example passes
`127.0.0.1` so the server is reachable only from your machine.

## Try it

```bash
curl -i -X POST localhost:3000/todos -H 'content-type: application/json' -d '{"title":"Buy flour"}'
```

```http
HTTP/1.1 201 Created
content-type: application/json; charset=utf-8

{"id":1,"title":"Buy flour","done":false}
```

Invalid input never reaches the handler. Knead answers with an
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem response that lists every issue:

```bash
curl -X POST localhost:3000/todos -H 'content-type: application/json' -d '{"title":""}'
```

```json
{
  "issues": [
    {
      "source": "body",
      "message": "Invalid length: Expected >=1 but received 0",
      "path": ["title"]
    }
  ],
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "Request validation failed",
  "instance": "/todos"
}
```

The response's `content-type` is `application/problem+json; charset=utf-8`. A missing todo
produces the `NotFoundException` from the service:

```bash
curl localhost:3000/todos/7
```

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "Todo 7 does not exist",
  "instance": "/todos/7"
}
```

> [!NOTE]
> The `detail` of an `HttpException` you throw is sent to the client in every mode, so write it
> for the client. Errors that are not `HttpException`s become a `500` whose details appear only
> in development. See [errors](/guide/errors/).

## Test it

`@knead-js/testing` compiles a module into an application and can start it on a random local
port. Requests then go through the real server and pipeline.

<<< start/todos.test.ts title="src/todos.test.ts"

```bash
bun test
```

Overrides, captured logs and GraphQL helpers are covered in [testing](/guide/testing/).

## Development mode

Knead runs in production mode unless `NODE_ENV` is `development`, or you pass
`development: true` to `KneadFactory.create()`. Development mode adds error details to `500`
responses. Run locally with:

```bash
NODE_ENV=development bun src/main.ts
```

Development mode is meant for your machine only. If you start it on a hostname other than
loopback, `listen()` warns that error details are exposed.

## Next steps

- [Modules](/guide/modules/) and [dependency injection](/guide/dependency-injection/) explain
  imports, exports, tokens and every provider form.
- [Controllers](/guide/controllers/), [request context](/guide/request-context/) and
  [validation](/guide/validation/) go deeper into request handling.
- [Configuration](/guide/configuration/) and [logging](/guide/logging/) prepare an app for
  production.
