---
title: Errors
description: Throw HttpException and its subclasses, get RFC 9457 problem responses, and understand how Knead masks and logs server errors outside development.
---

Knead answers every error with an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem
response (`application/problem+json`). Throw an `HttpException` to choose the status and the
details a client sees; anything else you throw is treated as a bug and becomes a masked `500`.

## Throwing HTTP exceptions

Throw an exception from a handler, guard, middleware or service. It travels up to the request
pipeline, which turns it into the response.

<<< http/errors.ts#throwing title="checkout.controller.ts"

`new HttpException(status, detail?, options?)` takes the status (an integer from 400 to 599; any
other value throws a `RangeError`), an optional `detail` for the client, and these options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | `string` | `'about:blank'` | A URI identifying the problem type. |
| `title` | `string` | the status's title from `STATUS_TITLES`, or `'Error'` | A short summary of the problem type. |
| `extensions` | `Record<string, unknown>` | `{}` | Extra members added to the problem body. |
| `headers` | `Bun.HeadersInit` | none | Headers added to the problem response, such as `Retry-After` or `WWW-Authenticate`. |
| `cause` | `unknown` | none | The underlying error, kept as the standard `Error.cause`. Never sent to the client. |

The exception's `message` is its `detail`, or its title when there is no detail, and its `name` is
the class name (`ConflictException`, or your own subclass's name).

### Built-in subclasses

Each subclass takes `(detail?, options?)`:

| Class | Status | Title |
| --- | --- | --- |
| `BadRequestException` | 400 | Bad Request |
| `UnauthorizedException` | 401 | Unauthorized |
| `ForbiddenException` | 403 | Forbidden |
| `NotFoundException` | 404 | Not Found |
| `MethodNotAllowedException` | 405 | Method Not Allowed |
| `ConflictException` | 409 | Conflict |
| `UnsupportedMediaTypeException` | 415 | Unsupported Media Type |
| `UnprocessableEntityException` | 422 | Unprocessable Content |
| `TooManyRequestsException` | 429 | Too Many Requests |
| `InternalServerErrorException` | 500 | Internal Server Error |
| `ServiceUnavailableException` | 503 | Service Unavailable |

`ValidationException` is a `BadRequestException` too (see [validation](/guide/validation/)).
`STATUS_TITLES` also has titles for 413 (`Content Too Large`) and 421 (`Misdirected Request`),
which Knead uses for its own responses. For any other status, pass a `title`, or it is `'Error'`.

### Your own exceptions

Extend `HttpException` for statuses or problem types that recur in your API:

<<< http/errors.ts#subclass title="payment-required.exception.ts"

## The problem response

An exception becomes a response with the exception's status, these headers, and a JSON body:

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json; charset=utf-8
X-Content-Type-Options: nosniff
```

```json
{
  "sku": "sold-out",
  "type": "https://example.com/problems/sold-out",
  "title": "Conflict",
  "status": 409,
  "detail": "SKU sold-out is sold out",
  "instance": "/checkout/sold-out"
}
```

| Member | Value |
| --- | --- |
| `type` | The exception's `type`, `about:blank` by default. |
| `title` | The exception's title. |
| `status` | The HTTP status. |
| `detail` | The exception's `detail`; left out when there is none. |
| `instance` | The request's path, without the query string. |
| extensions | Each member of `extensions`, at the top level of the object. |

Extensions cannot replace the standard members: an extension named `type`, `title`, `status` or
`instance` is overwritten by the real value, and so is one named `detail` when the exception has a
detail. Headers from the exception's `headers` option are added to the
response, both for 4xx and 5xx statuses. Headers set on `ctx.res.headers` are not, because they
belong to the success response (see [the response draft](/guide/request-context/)).

## Production masking

What a client sees depends on the development flag (`KneadFactory.create(root, { development })`,
default `process.env.NODE_ENV === 'development'`), and on whether the error is a client error or a
server error.

**4xx `HttpException`s** are sent in full in every mode: `detail` and extensions included. They
describe what the client did wrong, so write their details for clients.

**5xx `HttpException`s** outside development carry only `type`, `title`, `status`, `instance` and
a `correlationId`. The `detail` and the extensions are dropped, because they tend to describe
internals. Headers such as `Retry-After` are kept. Thrown with
`new ServiceUnavailableException('Inventory is unavailable', { headers: { 'retry-after': '30' } })`:

```json
{
  "type": "about:blank",
  "title": "Service Unavailable",
  "status": 503,
  "instance": "/checkout/widget",
  "correlationId": "0f91fe5a-f818-4b25-8a83-69fee3de4e11"
}
```

**Any other error** (a `TypeError`, a database driver error, a value the handler returned that
cannot be serialized as JSON) is an unknown error. Outside development the response is a bare
`500`:

```json
{
  "type": "about:blank",
  "title": "Internal Server Error",
  "status": 500,
  "instance": "/checkout/crash",
  "correlationId": "b6c0afc5-1ec2-4a58-872c-2cc748d51e05"
}
```

In development, a 5xx `HttpException` keeps its `detail` and extensions, and an unknown error's
response adds `detail` (the error's message) and `stack`. These are passed through credential
redaction first, so `redis://default:s3cret@cache:6379` in a message is sent as
`redis://***@cache:6379`. Development mode is for your machine only: `listen()` warns when it is on
and the server is bound to a non-loopback hostname.

> [!CAUTION]
> Never enable development mode on a reachable server. Error details and stacks describe your code,
> your dependencies and your data, even after credentials are redacted.

## Logging and correlation ids

Every 5xx is logged at the `error` level through the application's `LOGGER`, under a new
correlation id (a random UUID). The same id is the `correlationId` member of the response, so a
user can report it and you can find the log line. 4xx responses are not logged.

Outside development, the log line holds only the error's `Name: message`, with credentials
redacted and the message capped at 500 characters (`LOGGED_MESSAGE_LENGTH`). There is no stack,
cause or property dump, since those often hold request data. With the default `ConsoleLogger`:

```text
[knead] 503 on POST /checkout/widget (correlation id 9019a25c-98bf-4b3d-8c6e-901c635091f7): ServiceUnavailableException: Inventory is unavailable
[knead] Unhandled error on GET /checkout/crash (correlation id b6c0afc5-1ec2-4a58-872c-2cc748d51e05): Error: Lost connection to redis://***@cache:6379
```

In development the message is logged without the `: Name: message` suffix, and the whole error is
passed as the log entry's argument, redacted with `redactValue()` (credentials in its message,
stack, cause chain and properties replaced by `***`).

Redaction happens before the logger is called, so any `LOGGER` you install (see
[logging](/guide/logging/)) receives redacted data.

### Logging errors yourself

To log an error the same way, inject `ErrorLog` and call `log(message, error, level?)`. It returns
the correlation id; `level` is `'error'` (the default) or `'warn'`. Above, the controller logs the
underlying inventory error before throwing the `503`, since the `503`'s own log line names only the
`503`. Outside development that logs:

```text
[knead] Reserving widget failed (correlation id 5a1d3e0c-2f0b-4d6e-9b8a-61f1c2a7e4d9): Error: connect ECONNREFUSED postgres://***@10.0.0.5:5432/inventory
```

`logError(options, message, error, level?)` is the same function without injection, for code that
has a `{ logger, development }` pair at hand.

## Custom error responses

To change how some errors are answered, write an exception filter (see
[exception filters](/guide/exception-filters/)). Inside one, `defaultErrorResponse(error, ctx,
logger, development)` builds the response Knead would have sent, including the masking and the
logging described above, so a filter can adjust it instead of rebuilding it:

<<< http/default-error-response.ts#filter title="no-store-errors.filter.ts"

`problemResponse(problem, headers?)` builds a problem response from a `ProblemDetails` object
directly, with the `application/problem+json` content type and `nosniff`. Use
`exception.toProblem(instance?)` to get an exception's problem body.

## Errors Knead raises itself

The framework uses the same format for the errors it detects:

| Situation | Status | Detail |
| --- | --- | --- |
| No route matches the path | 404 | `No route for GET /nope` |
| The path matches, the method does not | 405 | `PUT is not allowed on /cats/1` (with an `Allow` header) |
| Malformed JSON body | 400 | `Malformed JSON body` |
| Malformed multipart body | 400 | `Malformed multipart body` |
| The body cannot be read | 400 | `Failed to read request body` |
| Unsupported `Content-Type` | 415 | `Unsupported content type: application/xml` |
| Too many query parameters | 400 | `The query string has more than 1000 parameters.` |
| Too many form fields | 413 | `The request body has more than 1000 fields.` |
| Schema validation failed | 400 | `Request validation failed` (with `issues`) |
| A guard did not return `true` | 403 | none |
| `Host` not in `allowedHosts` | 421 | `This server does not serve the requested host.` |

A request body larger than `maxRequestBodySize` is the exception: Bun rejects it with an empty
`413` before Knead sees the request (see [limits](/guide/request-context/)).

## Configuration errors

Mistakes in the application's setup, such as a duplicate route, an invalid guard or an invalid
`listen()` option, are not HTTP errors. They throw `HttpConfigError` (a `KneadError` from
`@knead-js/core`) when the application is bootstrapped or when `listen()` runs, never while a
request is being served. See [definition errors](/guide/controllers/) for the routing ones.

See the [`@knead-js/http` reference](/packages/http/) for every exception class and helper.
