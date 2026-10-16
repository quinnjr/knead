---
"@knead/core": minor
"@knead/http": minor
"@knead/testing": minor
"@knead/cors": minor
"@knead/rate-limit": minor
"@knead/security-headers": minor
"@knead/sanitize": minor
"@knead/graphql": minor
---

The framework formerly called hpmws is now Knead, and the packages are published as `@knead/*` (formerly `@hpmws/*`), from the renamed repository `quinnjr/knead`. There are no deprecated aliases:

- `HpmwsFactory` is now `KneadFactory`, and `HpmwsError` is now `KneadError`.
- Every `hpmws:` string namespace is now `knead:`: the metadata keys and symbol descriptions (`knead:module`, `knead:controller`, `knead:graphql:type`, …), the copy-guard symbols `Symbol.for('knead.core')` and `Symbol.for('knead.core.duplicateWarned')`, and the `ConsoleLogger` names (`knead:graphql`, `knead:rate-limit`; the default prefix is `[knead]`).
- The default Redis prefixes change: `RedisPubSub` channels use `knead:gql:` and `RedisStore` keys use `knead:rl:`. Update Redis ACLs that restrict keys or channels to the old prefix (for example `~knead:rl:*`).
- `RedisPubSub` derives its AES-256-GCM key with the HKDF label `knead:redis-pubsub:aes-256-gcm`, so instances on different versions cannot read each other's encrypted payloads.
- The Standard Schema `vendor` of `@knead/sanitize` schemas is `knead`.
