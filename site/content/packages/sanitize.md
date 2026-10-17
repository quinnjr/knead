---
title: Sanitize
description: Allowlist HTML sanitization with safe presets, validated custom policies and a Standard Schema wrapper for request validation.
---

```bash
bun add @knead-js/sanitize
```

`@knead-js/sanitize` cleans untrusted HTML (comments, rich-text fields, imported content) down to
an allowlist of tags, attributes and URL schemes before you store or render it. It is built on
[sanitize-html](https://github.com/apostrophecms/sanitize-html), pinned to an exact version, and
adds presets plus a policy check that refuses configurations that would let script back in.

Nothing is sanitized automatically: you call `sanitize()` yourself, or put `sanitizedHtml()` in a
route schema. Sanitize only input that is meant to be rendered as HTML. For plain text, escape it
when you render it instead. For request schemas in general, see
[validation](/guide/validation/); for the rest of the security model, [security](/guide/security/).

## `sanitize()`

`sanitize(html: string, policy: SanitizePolicy | PresetName = 'basic'): string` returns `html`
with everything outside the policy removed.

<<< security/sanitize.ts#function

What always happens, whatever the policy:

- Tags outside `allowedTags` are removed and their text kept, except the contents of `script`,
  `style`, `textarea` and `option`, which are dropped with the tag.
- Attributes outside `allowedAttributes` are removed.
- Every `<a>` gets `rel="noopener noreferrer"`, replacing any `rel` it had.
- URL attributes (`href`, `src`, `cite`, `action`, `background`, `poster`, `data`, `xlink:href`,
  `formaction`, `ping`) keep a URL only if its scheme is allowed: `http`, `https`, `mailto` and
  `tel` by default, and only `http` and `https` on `<img>`. Relative URLs (`/docs`, `#top`) are
  kept; protocol-relative ones (`//evil.example`) and `javascript:`, `vbscript:` and `data:` URLs
  are removed.
- An `<img>` left without a `src` is removed.

## Presets

`POLICIES` maps each `PresetName` (`'strict' | 'basic' | 'rich'`) to a frozen `SanitizePolicy`:

| Preset | Tags | Attributes |
| --- | --- | --- |
| `strict` | none: text only | none |
| `basic` (default) | `b`, `i`, `em`, `strong`, `a`, `p`, `br`, `code` | `a`: `href` |
| `rich` | everything in `basic`, plus `ul`, `ol`, `li`, `h1` to `h6`, `blockquote`, `pre`, `img` | `a`: `href`; `img`: `src`, `alt` |

The presets are frozen, arrays included. Build a custom policy from one by copying:

<<< security/sanitize.ts#policy

## `SanitizePolicy`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `allowedTags` | `readonly string[]` | required | Tags that are kept. |
| `allowedAttributes` | `Readonly<Record<string, readonly string[]>>` | required | Attributes kept, per tag name. Name each attribute: globs are rejected. |
| `allowedSchemes` | `readonly string[]` | the whole allowlist | Narrows the URL schemes. Every entry must be on the allowlist (`http`, `https`, `mailto`, `tel`, plus `extraSchemes`). `<img>` never gets `mailto` or `tel`. |
| `extraSchemes` | `readonly string[]` | none | Extends the allowlist, for example `['ftp']`. |
| `allowClobberingAttributes` | `boolean` | `false` | Allows `id` and `name` attributes. |

### Policy checks

Every call to `sanitize()` (and `sanitizedHtml()` with a custom policy, when it is created) checks
the policy first and throws a `TypeError` if it would re-enable a known XSS vector. The checks are
case-insensitive, so `SCRIPT` is caught like `script`, and they run on every call, so a policy
mutated after its first use is caught too.

| Rejected | Why |
| --- | --- |
| Tags `script`, `style`, `iframe`, `object`, `embed`, `svg`, `math`, `base`, `meta`, `link`, `form`, `input`, `textarea`, `select`, `button`, `noscript`, `template` | They run script, load content, or change how the page parses. |
| Tags `xmp`, `noembed`, `noframes`, `plaintext`, `title`, `frame`, `frameset`, `applet`, `portal` | Raw-text and legacy elements behind parser differentials and mutation XSS, and embedding elements. |
| Attributes starting with `on`, and `style`, `srcdoc`, `formaction` | Event handlers, CSS and embedded documents. |
| Attribute names containing `*` | sanitize-html expands globs, so `'*'` or `'o*'` would match `onclick`. |
| `id` and `name`, unless `allowClobberingAttributes: true` | They can shadow DOM globals (`<a id="cookie">`) in some page scripts. |
| `javascript`, `vbscript` and `data` in `extraSchemes` or `allowedSchemes` | They run script or embed arbitrary content. |
| An `extraSchemes` entry that is not a scheme name | Only `[a-z][a-z0-9+.-]*` is accepted. |
| An `allowedSchemes` entry not on the allowlist | Add it to `extraSchemes` first. |

## `sanitizedHtml()`

`sanitizedHtml(inner: StandardSchemaV1, policy: SanitizePolicy | PresetName = 'basic')` returns a
Standard Schema whose input is `inner`'s input and whose output is a `string`. It validates the
value with `inner`; if that fails, its issues are returned unchanged. Otherwise it sanitizes the
output with `policy`. An `inner` that outputs something other than a string produces the issue
`sanitizedHtml() requires the inner schema to output a string`. A custom policy is checked when
`sanitizedHtml()` is called, so a bad policy fails at startup.

It works as a whole route schema, for example a body sent as `text/plain`:

<<< security/sanitize.ts#schema title="notes.controller.ts"

Schema libraries such as valibot or zod accept only their own schemas inside an object, so for a
field of an object body, call `sanitize()` in the library's transform step:

<<< security/sanitize.ts#field title="posts.controller.ts"

Limit the length before sanitizing, as above: the request body limit caps the size, but a smaller
field limit keeps sanitizing cheap.
