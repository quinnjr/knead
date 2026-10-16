---
"@hpmws/security-headers": patch
---

A one-time warning is logged when HSTS is on with `0 < maxAge < 15552000` (under 180 days).
