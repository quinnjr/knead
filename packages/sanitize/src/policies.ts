export interface SanitizePolicy {
  allowedTags: readonly string[];
  allowedAttributes: Readonly<Record<string, readonly string[]>>;
  /** URL schemes allowed in href/src. Default: http, https, mailto (img: http, https only).
   * When set, it applies to every tag, including img (minus mailto). `javascript`, `vbscript`
   * and `data` are rejected. */
  allowedSchemes?: readonly string[];
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
