---
'@knead-js/core': patch
---

`redactValue` (and so every logger) now treats any key containing a secret word as sensitive, whatever its case or separators (`db_password`, `userPassword`, `x-api-key`, `clientSecret`, `access_token`, `sessionId`); such keys keep number and boolean values. Credentials in object, Map and Error property keys are redacted, and an Error whose cause chain is longer than 16 is always printed redacted and truncated, never raw.
