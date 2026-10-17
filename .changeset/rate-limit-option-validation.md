---
'@knead-js/rate-limit': patch
---

`RateLimitModule.forRoot()` rejects an unknown `onStoreError` or `algorithm` with a `RangeError`. A typo in `onStoreError` (anything but `'deny'`) silently failed open, and a typo in `algorithm` silently used the sliding window.
