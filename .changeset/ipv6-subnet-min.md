---
"@knead/http": patch
"@knead/rate-limit": patch
---

`websocket.ipv6Subnet` and the rate-limit `ipv6Subnet` must be 1 to 128: 0 put every IPv6 client into one group and is now a configuration error.
