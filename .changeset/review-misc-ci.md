---
'@knead-js/core': minor
'@knead-js/logging': patch
'@knead-js/prisma': patch
'@knead-js/casl': patch
'@knead-js/security-headers': patch
---

Review fixes:

- `@knead-js/security-headers`: a `script-src` (or `style-src`) set to `true` gets the CSP nonce
  alone instead of inheriting the `default-src` sources.
- `@knead-js/casl`: `validateGrant()` no longer approves a pair the user is denied by a later
  unconditional `cannot`; a method's `@Can()` now overrides its controller's `@SkipAbility()`
  (it failed open), while `@SkipAbility()` still wins on the same method or controller.
- `@knead-js/prisma`: `withRollback()` rejects with the rollback-only `KneadError` when an inner
  `@Transactional()` call failed, even if the test function caught it, as the owning run does in
  production.
- `@knead-js/core`: exports `errorText()` and `isPlainObject()`, now shared by
  `@knead-js/logging` and `@knead-js/prisma/http`; `redactValue()` prints an Error whose `stack`
  is not a string as `Name: message` instead of `[unloggable value: …]`.
