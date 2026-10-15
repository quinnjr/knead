export interface SanitizePolicy {
  allowedTags: readonly string[];
  allowedAttributes: Readonly<Record<string, readonly string[]>>;
  /** URL schemes allowed in href/src. Default: http, https, mailto (img: http, https). */
  allowedSchemes?: readonly string[];
}

export type PresetName = 'strict' | 'basic' | 'rich';

const BASIC_TAGS = ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'code'] as const;

export const POLICIES: Readonly<Record<PresetName, SanitizePolicy>> = Object.freeze({
  strict: Object.freeze({ allowedTags: [], allowedAttributes: {} }),
  basic: Object.freeze({ allowedTags: [...BASIC_TAGS], allowedAttributes: { a: ['href'] } }),
  rich: Object.freeze({
    allowedTags: [
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
    allowedAttributes: { a: ['href'], img: ['src', 'alt'] },
  }),
});
