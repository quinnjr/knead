---
title: Validation
description: Validate path parameters, query, headers and body with any Standard Schema library, and get typed, transformed handler inputs and 400 responses that list every issue.
---

A route can declare a schema for each of its inputs. Knead validates the request against them
before the handler runs, replaces each input with the schema's output, and answers a failed request
with a `400` that lists every issue. Schemas are [Standard Schema](https://standardschema.dev)
objects, so any library that implements it works: Valibot, Zod, ArkType and others. The examples
here use [Valibot](https://valibot.dev).

## Declaring schemas

Pass schemas in the route options: `params`, `query`, `headers` and `body` (the
`ValidationSource` values).

<<< http/validation.ts#schemas title="books.schemas.ts"

<<< http/validation.ts#controller title="books.controller.ts"

When a source validates, its context field holds the schema's output, not the raw input:

- `ctx.params`, `ctx.query` and `ctx.headers` are replaced by the output. Above, `params.id` is a
  number (the schema transforms it) and `query.fields` has its default.
- `ctx.body` is set to the output, and `ctx.json()` resolves to it as well, so code that reads the
  body through `ctx.json()` also gets the validated value.

Schemas that strip unknown keys (Valibot's `v.object`, for example) therefore remove them from the
context: a `POST /books` with an extra `"draft": true` field reaches the handler without it.

## Typed handler inputs

The route decorator checks the handler's `ctx` type against the schemas' output types, so a
handler cannot claim an input shape the schema does not produce. Write the type with your library's
inference helper, such as `v.InferOutput<typeof CreateBook>`, or spell it out:

- `Ctx<{ body: v.InferOutput<typeof CreateBook> }>` on a route with `body: CreateBook` compiles.
- `Ctx<{ body: { title: number } }>` on the same route is a type error.
- `Ctx<{ query: { fields: string } }>` where the query schema outputs a literal union compiles,
  because the output is assignable to it; `{ fields: number }` does not.

Without a schema, `params` is typed from the path, `query` and `headers` are string records, and
`body` is `undefined` (see [typing the context](/guide/request-context/)).

## Order and aggregation

For a matched route, the request goes through middleware, then guards, then validation, then the
route's `authorize` guards, then the handler. Validation checks the sources in this order:
`params`, `query`, `headers`, `body`. It checks all of them even when an earlier one fails, and
collects every issue into one response, so a client sees all its mistakes at once.

To validate the body, Knead parses it with `ctx.json()` first. A body that cannot be parsed fails
before validation, with the parser's own error instead of a validation issue: a `400` with the
detail `Malformed JSON body`, or a `415` for an unsupported `Content-Type` (see
[the request body](/guide/request-context/)).

Async schemas work: the validation result is awaited.

## The error response

A failed validation throws a `ValidationException`, a `BadRequestException` whose problem body has
an `issues` member:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json; charset=utf-8
X-Content-Type-Options: nosniff
```

```json
{
  "issues": [
    { "source": "params", "message": "id must be numeric", "path": ["id"] },
    { "source": "query", "message": "fields must be summary or full", "path": ["fields"] }
  ],
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "Request validation failed",
  "instance": "/books/abc"
}
```

This is the response to `GET /books/abc?fields=all` on the controller above. Each issue is a
`ValidationIssue`:

| Member | Type | Description |
| --- | --- | --- |
| `source` | `'params' \| 'query' \| 'headers' \| 'body'` | Which input failed. |
| `message` | `string` | The schema library's message (see [redacting messages](#redacting-messages)). |
| `path` | `string[]` | The path to the failing value inside that input, every segment a string (an array index `0` becomes `"0"`). Empty when the input as a whole failed. |

The message is whatever the schema produced. For a missing required key Valibot reports, for
example, `Invalid key: Expected "title" but received undefined`; pass custom messages to the schema
functions (as `v.regex(..., 'id must be numeric')` does above) to control the text.

## Redacting messages

Some schema libraries quote the offending input in their messages, which would echo it back to the
client. Two rules keep that in check:

- Issues from the `headers` source always have the message `Invalid header value`, whatever the
  schema said, because header values are often tokens and cookies.
- `listen({ validation: { redactIssueMessages: true } })` (default `false`) replaces the messages
  of `params`, `query` and `body` issues with `Invalid value` too. `source` and `path` are kept, so
  clients can still tell which field failed.

| `ValidationOptions` member | Type | Default | Description |
| --- | --- | --- | --- |
| `redactIssueMessages` | `boolean` | `false` | Replace `params`, `query` and `body` issue messages with `Invalid value`. |

## Validating headers

`ctx.headers` holds every request header with a lowercase name, so write header schemas with
lowercase keys. Use a schema that keeps unknown keys (Valibot's `v.looseObject`), or `ctx.headers`
will hold only the headers you declared after validation.

<<< http/validation.ts#headers title="versioned.controller.ts"

## Authorization on validated input

Guards in `guards` (and global guards) run before validation and see the raw request. When an
authorization decision depends on the canonical input, such as a trimmed, lowercased email address
or a coerced id, put the guard in the route's `authorize` option instead: those guards run after
validation and see the schema output on `ctx.body`, `ctx.params`, `ctx.query` and `ctx.headers`.
Like every guard, an `authorize` guard passes only when it returns exactly `true`; anything else is
a `403`.

<<< http/validation.ts#authorize title="invites.controller.ts"

Here `{ "email": " Ada@Example.com " }` is accepted and the handler receives `ada@example.com`,
while `ada@other.org` is a `403`. See [guards](/guide/guards/) for guards in general.

WebSocket upgrades are not validated: on an upgrade to the path of a `GET` route, that route's
`authorize` guards run with the raw request.

## Throwing a ValidationException yourself

For checks a schema cannot express, throw `new ValidationException(issues)` from the handler with
your own `ValidationIssue` list. The response has the same shape as a schema failure. For a
different status, such as `422`, throw an `UnprocessableEntityException` with an `extensions`
member of your choice instead (see [errors](/guide/errors/)).

See the [`@knead-js/http` reference](/packages/http/) for `ValidationException`, `ValidationIssue`,
`ValidationOptions` and `ValidationSource`.
