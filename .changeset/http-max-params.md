---
"@hpmws/http": minor
---

Repeated query and form keys are collected in place (copying made 100k repeats quadratic), and the new `listen({ maxParams })` (default 1000) caps query parameters (400) and urlencoded/multipart body fields (413).
