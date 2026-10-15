# @hpmws/sanitize

Opt-in allowlist HTML sanitization (`strict`, `basic`, `rich` presets) via `sanitize()` or the `sanitizedHtml(schema)` Standard Schema wrapper, backed by `sanitize-html`. Never applied automatically. Custom policies cannot allow XSS-capable tags or attributes (`script`, `style`, `iframe`, `on*`, …), and an `img` without `src` is dropped.

`bun add @hpmws/sanitize`. Licensed MIT OR Apache-2.0.
