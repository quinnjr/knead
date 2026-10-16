export interface SanitizePolicy {
  allowedTags: readonly string[];
  /** `id` and `name` (DOM clobbering) also need `allowClobberingAttributes: true`. */
  allowedAttributes: Readonly<Record<string, readonly string[]>>;
  /**
   * URL schemes allowed in URL attributes (href, src, cite, action, poster, …). Every entry must
   * be on the allowlist (http, https, mailto, tel, plus `extraSchemes`). Default: the whole
   * allowlist. `img` never gets mailto or tel.
   */
  allowedSchemes?: readonly string[];
  /** Extends the scheme allowlist (e.g. `['ftp']`). `javascript`, `vbscript` and `data` are rejected. */
  extraSchemes?: readonly string[];
  /** Allows `id` and `name` attributes, which can clobber DOM globals. Default false. */
  allowClobberingAttributes?: boolean;
}

export type PresetName = 'strict' | 'basic' | 'rich';

const BASIC_TAGS = ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'code'] as const;

const freeze = (
  tags: readonly string[],
  attrs: Record<string, readonly string[]>,
): SanitizePolicy =>
  Object.freeze({
    allowedTags: Object.freeze([...tags]),
    allowedAttributes: Object.freeze(
      Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, Object.freeze([...v])])),
    ),
  });

export const POLICIES: Readonly<Record<PresetName, SanitizePolicy>> = Object.freeze({
  strict: freeze([], {}),
  basic: freeze(BASIC_TAGS, { a: ['href'] }),
  rich: freeze(
    [
      ...BASIC_TAGS,
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'blockquote',
      'pre',
      'img',
    ],
    { a: ['href'], img: ['src', 'alt'] },
  ),
});
