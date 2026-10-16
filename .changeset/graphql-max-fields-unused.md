---
"@knead-js/graphql": patch
---

`maxFields` also counts the field nodes written in every operation and fragment definition, including fragments that are never spread (validation visits them all).
