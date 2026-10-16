---
"@knead/security-headers": minor
---

HSTS options are validated (integer `maxAge` ≥ 0; `preload` requires `includeSubDomains` and `maxAge` ≥ 31536000). New default headers: `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()` (`permissionsPolicy`) and `X-Permitted-Cross-Domain-Policies: none` (`xPermittedCrossDomainPolicies`).
