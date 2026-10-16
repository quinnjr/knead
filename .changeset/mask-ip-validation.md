---
"@knead/http": patch
"@knead/rate-limit": patch
---

`maskIp(ip, prefix)` throws a `RangeError` unless the prefix is an integer from 0 to 128, and returns IPv4-mapped input (`::ffff:1.2.3.4`) in its IPv4 form, so it shares a key with `1.2.3.4`. `websocket.ipv6Subnet` and the rate-limit `ipv6Subnet` accept the same range (0 to 128), checked by the new exported `isIpv6Prefix`.
