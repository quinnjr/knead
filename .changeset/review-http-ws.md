---
'@knead-js/http': patch
'@knead-js/testing': patch
---

WebSocket, proxy and testing fixes from the code review:

- `trustProxy` CIDRs need a prefix of 1 to 3 decimal digits: `10.0.0.0/` (which `Number('')` read as `/0`, trusting every address), `/0x8`, `/ 8`, `/1e1` and `10.0.0.0/8/x` are now `HttpConfigError`s, as are non-string entries.
- An upgrade whose guards took over 30 seconds returns its connection slot when its socket never opens, instead of holding it forever.
- An endpoint `open()` that throws closes the socket with `1011` instead of leaving it open.
- `message`, `close` and `drain` run only for sockets whose `open` ran (not for sockets revoked while upgrading or closed with `1013`).
- `allowedOrigins` entries must be exact origins (`scheme://host[:port]`): paths, trailing slashes, default ports and wildcards are rejected at `register()`.
- `maxConnectionLifetime` above `2 ** 31 - 1` and `idleTimeout` above 960 are rejected instead of closing every socket at once or wrapping around.
- `HttpException` titles fall back to `node:http`'s reason phrases (`502 Bad Gateway`, `504 Gateway Timeout`, ...) before `'Error'`.
- `TestApp.request()` and `graphqlSubscribe()` require paths starting with `/` and always target the test server (`'//host/x'` no longer goes to another host).
- `graphqlSubscribe()` iterators reject on an abnormal close (any code but 1000) or a non-JSON frame instead of ending quietly or hanging.
