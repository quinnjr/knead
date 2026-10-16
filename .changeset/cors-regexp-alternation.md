---
"@knead/cors": patch
---

A RegExp `origin` with a top-level `|` (such as `/^https:\/\/a\.com|https:\/\/b\.com$/`, where each anchor covers only one side) is a `CorsConfigError` telling you to wrap it as `^(?:a|b)$`.
