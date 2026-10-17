---
'@knead-js/security-headers': patch
---

Every header-valued option (`referrerPolicy`, `crossOriginOpenerPolicy`, `crossOriginResourcePolicy`, `xContentTypeOptions`, `xFrameOptions`, `xDnsPrefetchControl`, `permissionsPolicy`, `xPermittedCrossDomainPolicies`) must be a string without control characters other than tab, checked at startup. Only `permissionsPolicy` was checked before, so a line break in another value passed validation and then failed every response with a 500.
