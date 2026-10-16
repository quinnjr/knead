---
"@hpmws/graphql": patch
---

Computed subscription topics longer than 256 characters are rejected with `BAD_USER_INPUT`, next to the wildcard check.
