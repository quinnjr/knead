---
"@hpmws/rate-limit": minor
---

Store-key hashing is keyed: `hashKey(key, secret?)` is HMAC-SHA256 under a secret, `MemoryStore` uses a random per-process secret, and `RedisStore` takes `hashSecret` (at least 32 bytes, shared across instances). Without it `RedisStore` falls back to plain SHA-256 and logs a one-time warning that IPs are recoverable from the Redis keys. The docs no longer claim an unkeyed hash hides client IPs.
