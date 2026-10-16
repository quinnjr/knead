---
"@knead-js/cors": minor
---

A RegExp `origin` that does not start with `^` and end with `$` is now a `CorsConfigError` at `forRoot()` (it matched anywhere in the Origin, e.g. `https://app.example.evil`).
