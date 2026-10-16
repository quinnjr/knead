# @hpmws/sanitize

Opt-in allowlist HTML sanitization (`strict`, `basic`, `rich` presets) via `sanitize()` or the `sanitizedHtml(schema)` Standard Schema wrapper, backed by `sanitize-html`. Never applied automatically. Custom policies cannot allow XSS-capable tags (`script`, `style`, `iframe`, `object`, `svg`, `math`, `form`, `template`, the raw-text and legacy elements `xmp`, `noembed`, `noframes`, `plaintext`, `title`, `frame`, `frameset`, `applet`, `portal`, …) or attributes (`on*`, `style`, `srcdoc`, `formaction`), or attribute patterns containing `*` (sanitize-html expands globs, so `'*'` or `'o*'` would re-enable `onclick`; list attributes explicitly). `id` and `name` can clobber DOM globals (`<a id="cookie">` shadows `document.cookie` lookups in some code), so a policy that allows them must also set `allowClobberingAttributes: true`. All checks are case-insensitive and throw a `TypeError`. An `img` without `src` is dropped.

URL schemes are an allowlist: `http`, `https`, `mailto` and `tel` (`img` only `http` and `https`), checked on every URL attribute (`href`, `src`, `cite`, `action`, `background`, `poster`, `data`, `xlink:href`, `formaction`, `ping`). `allowedSchemes` narrows the list and may only name allowlisted schemes; `extraSchemes: ['ftp']` extends the allowlist. `javascript`, `vbscript` and `data` can never be allowed.

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
