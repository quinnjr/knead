---
'@knead-js/core': minor
'@knead-js/http': minor
'@knead-js/casl': minor
'@knead-js/config': minor
'@knead-js/cors': minor
'@knead-js/graphql': minor
'@knead-js/logging': minor
'@knead-js/prisma': minor
'@knead-js/rate-limit': minor
'@knead-js/sanitize': minor
'@knead-js/schedule': minor
'@knead-js/security-headers': minor
'@knead-js/testing': minor
---

**Breaking:** `@Injectable()` is now required on every class the container constructs as a
provider, whether listed in `providers` or used through `useClass` (including testing overrides).
An unmarked class is a `ProviderConfigError` at bootstrap naming the class and module. Value,
factory and alias providers, and guard, middleware and filter classes, need no decorator.
`@Controller()`, `@Resolver()` and `@Catch()` mark their classes. New `markInjectable(metadata)`
lets other class decorators do the same; `normalizeProvider()` takes an optional `owner` for its
error messages.
