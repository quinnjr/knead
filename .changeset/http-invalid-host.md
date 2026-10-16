---
"@hpmws/http": patch
---

Requests whose `Host` header does not form a valid URL (Bun then gives them a relative `req.url`) no longer fail with a bare 500: routing, `ctx.query`, 404/405 and problem responses resolve the URL through the new exported `requestUrl(req)`, and the `redirectHttp` listener answers `400` unless a canonical `host` is configured.
