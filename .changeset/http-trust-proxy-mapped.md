---
"@knead/http": patch
---

`trustProxy` accepts IPv4-mapped CIDR entries (`::ffff:10.0.0.0/104` matches as `10.0.0.0/8`), and `listen()` warns once when a hop count is combined with a wildcard hostname (`0.0.0.0`/`::`).
