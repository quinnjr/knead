---
"@knead/graphql": patch
---

`recheckGuards: true` also re-runs a subscription's `authorize` guards, after `guards`, against the validated arguments.
