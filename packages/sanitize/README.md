# @knead-js/sanitize

[![npm](https://img.shields.io/npm/v/@knead-js/sanitize?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/sanitize)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

Allowlist HTML sanitization for untrusted input such as comments and rich-text fields, with safe
presets, validated custom policies and a Standard Schema wrapper for request validation. Part of
[Knead](https://github.com/quinnjr/knead), usable on its own.

**[Documentation](https://quinnjr.github.io/knead/packages/sanitize/)** · [Guide](https://quinnjr.github.io/knead/guide/security/) · [Knead](https://github.com/quinnjr/knead)

## Install

```bash
bun add @knead-js/sanitize
```

Requires Bun 1.4.3 or newer. There are no peer dependencies: the package depends only on
[sanitize-html](https://github.com/apostrophecms/sanitize-html), pinned to an exact version, and
the Standard Schema types.

## Quick start

```ts
import { sanitize } from '@knead-js/sanitize';

// The default 'basic' policy keeps simple formatting and links, and drops everything else.
export const comment = sanitize(
  '<p onclick="steal()">Read <a href="javascript:steal()">this</a> and <a href="https://example.com">that</a></p><script>steal()</script>',
);
// '<p>Read <a rel="noopener noreferrer">this</a> and <a href="https://example.com" rel="noopener noreferrer">that</a></p>'

// 'strict' keeps the text only.
export const title = sanitize('<h1>Release <em>notes</em></h1>', 'strict');
// 'Release notes'
```

Nothing is sanitized automatically: you call `sanitize()` yourself, or put `sanitizedHtml()` in a
route schema. Sanitize only input that is meant to be rendered as HTML; escape plain text when you
render it instead.

## Features

- **Allowlist, not blocklist.** Only the tags, attributes and URL schemes a policy names survive.
- **Three presets.** `strict` (text only), `basic` (the default) and `rich`.
- **Safe URLs.** `javascript:`, `vbscript:`, `data:` and protocol-relative URLs are removed;
  relative URLs are kept.
- **Safe links.** Every `<a>` gets `rel="noopener noreferrer"`.
- **Policies that cannot re-enable XSS.** Custom policies that allow `script`, event handlers,
  `style` or attribute globs throw a `TypeError`.
- **Request validation.** `sanitizedHtml()` wraps any Standard Schema and sanitizes its output.

## Presets

| Preset | Tags | Attributes |
| --- | --- | --- |
| `strict` | none: text only | none |
| `basic` (default) | `b`, `i`, `em`, `strong`, `a`, `p`, `br`, `code` | `a`: `href` |
| `rich` | everything in `basic`, plus `ul`, `ol`, `li`, `h1` to `h6`, `blockquote`, `pre`, `img` | `a`: `href`; `img`: `src`, `alt` |

Whatever the policy:

- Tags outside the policy are removed and their text kept, except the contents of `script`,
  `style`, `textarea` and `option`, which are dropped with the tag.
- URL attributes keep a URL only if its scheme is allowed: `http`, `https`, `mailto` and `tel` by
  default, and only `http` and `https` on `<img>`.
- An `<img>` left without a `src` is removed.

## Custom policies

The presets in `POLICIES` are frozen, arrays included. Build a custom policy by copying one:

```ts
export const commentPolicy: SanitizePolicy = {
  allowedTags: [...POLICIES.basic.allowedTags, 'blockquote'],
  allowedAttributes: { a: ['href', 'title'] },
  allowedSchemes: ['https'],
};

export const comment = sanitize(
  '<a href="http://example.com" title="Docs">docs</a> <a href="https://example.com">docs</a>',
  commentPolicy,
);
// '<a title="Docs" rel="noopener noreferrer">docs</a> <a href="https://example.com" rel="noopener noreferrer">docs</a>'
```

| Field | Default | Description |
| --- | --- | --- |
| `allowedTags` | required | Tags that are kept. |
| `allowedAttributes` | required | Attributes kept, per tag name. Name each attribute: globs are rejected. |
| `allowedSchemes` | the whole allowlist | Narrows the URL schemes to entries of the allowlist. |
| `extraSchemes` | none | Extends the allowlist, for example `['ftp']`. |
| `allowClobberingAttributes` | `false` | Allows `id` and `name`, which can shadow DOM globals. |

Every call checks the policy first, case-insensitively, and throws a `TypeError` if it allows:

- tags that run script, load content or change parsing: `script`, `style`, `iframe`, `object`,
  `embed`, `svg`, `math`, `form`, `template`, raw-text and legacy elements such as `xmp`,
  `noembed`, `plaintext` and `frameset`, and the rest of the list in the
  [reference](https://quinnjr.github.io/knead/packages/sanitize/#policy-checks);
- attributes starting with `on`, and `style`, `srcdoc` and `formaction`;
- attribute names containing `*` (sanitize-html expands globs, so `'o*'` would match `onclick`);
- `id` or `name` without `allowClobberingAttributes: true`;
- the `javascript`, `vbscript` or `data` scheme.

## Request validation

`sanitizedHtml(inner, policy?)` returns a Standard Schema that validates with `inner`, then
sanitizes its string output. It works as a whole route schema, for example a `text/plain` body:

```ts
@Controller('/notes')
export class NotesController {
  // The whole body is the HTML: send it as text/plain.
  @Post('/', { body: sanitizedHtml(v.pipe(v.string(), v.maxLength(10_000)), 'rich') })
  create(ctx: Ctx<{ body: string }>) {
    return { html: ctx.body };
  }
}
```

Schema libraries such as Valibot and Zod accept only their own schemas inside an object, so for a
field of an object body, call `sanitize()` in the library's transform step:

```ts
const CreatePost = v.object({
  title: v.pipe(v.string(), v.maxLength(200)),
  body: v.pipe(
    v.string(),
    v.maxLength(50_000),
    v.transform((html) => sanitize(html, 'basic')),
  ),
});

@Controller('/posts')
export class PostsController {
  @Post('/', { body: CreatePost })
  create(ctx: Ctx<{ body: v.InferOutput<typeof CreatePost> }>) {
    return ctx.body;
  }
}
```

Limit the length before sanitizing, as above: the request body limit caps the size, but a smaller
field limit keeps sanitizing cheap. A custom policy given to `sanitizedHtml()` is checked when the
schema is created, so a bad policy fails at startup.

## Documentation

- [`@knead-js/sanitize` reference](https://quinnjr.github.io/knead/packages/sanitize/): every
  rule, policy check and export.
- [Security guide](https://quinnjr.github.io/knead/guide/security/): where sanitization fits in
  Knead's security model.
- [Validation guide](https://quinnjr.github.io/knead/guide/validation/): route schemas for bodies,
  queries and parameters.

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
