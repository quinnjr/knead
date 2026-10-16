---
"@hpmws/graphql": minor
---

New `subscriptions.refreshContext({ http, context })`, called before every recheck of a `recheckGuards: true` subscription: its result is merged over the operation's context, and `false` ends the subscription with FORBIDDEN. The README states that rechecked guards otherwise see the connect-time identity.
