---
'@knead-js/http': minor
'@knead-js/casl': minor
---

`@knead-js/http`: `WsRegistry.register()` accepts `meta`, route-style metadata that guards read as `ctx.meta` on the upgrade request (merged over the GET route's meta when the endpoint shares its path).

`@knead-js/casl`: add `canMeta()` and `skipAbilityMeta()`, the meta forms of `@Can()` and `@SkipAbility()`, so a global `AbilityGuard` can authorize WebSocket endpoints that have no GET route.
