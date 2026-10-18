---
'@knead-js/graphql': patch
---

Upgrade Leaven to 0.3.0 (`@leaven-graphql/core`, `errors` and `ws`).

- Errors in the document itself now carry an `extensions.code`: a syntax error or too many tokens is `PARSE_ERROR`, and an unknown field, an invalid literal argument or a disabled introspection field is `VALIDATION_ERROR`. Their graphql-js messages are kept under `maskErrors`, and `application/graphql-response+json` still answers 400.
- A missing or unknown operation name, or a variable that does not coerce, is still `BAD_USER_INPUT` (Leaven now codes these `BAD_REQUEST`, which Knead maps).
- A repeated `connection_init` is still closed with 4429. Leaven does this itself now, so Knead's own guard is removed.
