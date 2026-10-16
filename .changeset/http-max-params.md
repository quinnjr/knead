---
"@hpmws/http": minor
---

Repeated query and form keys are collected in place (copying made 100k repeats quadratic), and the new `listen({ maxParams })` (default 1000) caps query parameters (400) and urlencoded/multipart body fields (413).

**New default limit.** Requests with more than 1000 query parameters or form fields are now rejected; raise it with `app.listen({ maxParams: 5000 })`.
