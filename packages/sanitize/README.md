# @hpmws/sanitize

Opt-in allowlist HTML sanitization (`strict`, `basic`, `rich` presets) via `sanitize()` or the `sanitizedHtml(schema)` Standard Schema wrapper, backed by `sanitize-html`. Never applied automatically. Custom policies cannot allow XSS-capable tags or attributes (`script`, `style`, `iframe`, `on*`, …), attribute patterns containing `*` (sanitize-html expands globs, so `'*'` or `'o*'` would re-enable `onclick`; list attributes explicitly), or the `javascript:`, `vbscript:` and `data:` URL schemes in `allowedSchemes` (all checks are case-insensitive and throw a `TypeError`). An `img` without `src` is dropped.

`bun add @hpmws/sanitize`. Licensed MIT OR Apache-2.0.
