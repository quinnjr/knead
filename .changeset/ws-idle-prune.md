---
"@knead/http": patch
---

Kept `closeWhere` predicates are dropped when no upgrade is pending (on a `closeWhere` with nothing pending, and when a socket closes), so an idle server holds no predicate closures.
