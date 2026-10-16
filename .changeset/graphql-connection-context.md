---
"@knead/graphql": patch
---

`GraphQLConnection.context` (what `GraphQLSubscriptions.closeWhere` predicates match) is the merged identity: the `context(http)` factory result, computed once at connection init, plus the `onConnect` result. `closeWhere` logs at debug level when it matches no socket.
