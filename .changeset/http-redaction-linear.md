---
"@knead-js/http": patch
---

`redactCredentials` runs in linear time: a scheme may only start where no scheme character precedes it, and the scheme (32) and userinfo (1024) scans are capped. Pathological 1 MB inputs previously took seconds.
