---
"@knead/http": minor
---

`trustProxy` hardening: in hop mode, `X-Forwarded-For`/`X-Forwarded-Proto` with fewer entries than hops are ignored; `ctx.ip` is canonicalized from the parsed bytes (hex IPv4-mapped and expanded IPv6 included); one warning is logged when `X-Forwarded-*` arrives while `trustProxy` is off. `normalizeIp`, `parseIp` and `formatIp` are exported.
