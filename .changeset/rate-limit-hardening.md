---
"@knead-js/rate-limit": minor
---

The default key masks IPv6 addresses to a /64 (`ipv6Subnet`). `MemoryStore` and `RedisStore` hash keys with SHA-256 by default (`hashKeys`). `onMissingKey: 'skip' | 'shared' | 'deny'` (default `'shared'`, one anonymous bucket per scope) replaces the old skip-when-keyless behaviour. Durations above one year are a `RangeError`. `maskIp`, `hashKey`, `MAX_DURATION_MS` and `validateRateLimitOptions` are exported.
