---
"@knead-js/http": patch
---

Secret `key=value` redaction matches keys case-insensitively with any prefix or suffix (`access_token=`, `client_secret=`, `id_token=`, `DB_PASSWORD=`, `PGPASSWORD=`), still in linear time, and `Bearer`/`Basic` credentials in any case.
