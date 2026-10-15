# @hpmws/sanitize

Opt-in allowlist HTML sanitization (`strict`, `basic`, `rich` presets) via `sanitize()` or the `sanitizedHtml(schema)` Standard Schema wrapper, backed by `sanitize-html`. Never applied automatically. Custom policies cannot allow XSS-capable tags or attributes (`script`, `style`, `iframe`, `on*`, …), attribute patterns containing `*` (sanitize-html expands globs, so `'*'` or `'o*'` would re-enable `onclick`; list attributes explicitly), or the `javascript:`, `vbscript:` and `data:` URL schemes in `allowedSchemes` (all checks are case-insensitive and throw a `TypeError`). An `img` without `src` is dropped.

`sanitizedHtml()` returns a standalone Standard Schema, suitable as a whole route body or query schema. It cannot be nested inside valibot or zod object schemas (they only accept their own schema types). For a field inside an object, sanitize in the library's own transform step:

```ts
import { sanitize } from '@hpmws/sanitize';
import * as v from 'valibot';

const CreatePost = v.object({
  title: v.string(),
  body: v.pipe(v.string(), v.transform((html) => sanitize(html, 'basic'))),
});
```

`bun add @hpmws/sanitize`. Licensed MIT OR Apache-2.0.
