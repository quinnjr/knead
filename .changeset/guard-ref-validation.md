---
"@knead-js/http": minor
"@knead-js/graphql": patch
---

Guard references are validated at `listen()` (HTTP) and bootstrap (GraphQL): anything but an object with `canActivate()`, a function, or a class with `canActivate()` on its prototype (for example `undefined` from a circular import, or an arrow-function field) is an `HttpConfigError` naming the controller, route or resolver. `assertGuardRef()` is exported.
