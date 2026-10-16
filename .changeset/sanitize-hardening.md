---
"@knead/sanitize": minor
---

`xmp`, `noembed`, `noframes`, `plaintext`, `title`, `frame`, `frameset`, `applet` and `portal` can no longer be allowed. URL schemes are an allowlist (`http`, `https`, `mailto`, `tel`; extend it with `extraSchemes`) checked on every URL attribute (`href`, `src`, `cite`, `action`, `background`, `poster`, `data`, `xlink:href`, `formaction`, `ping`). Policies that allow `id` or `name` must set `allowClobberingAttributes: true`.
