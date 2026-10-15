import sanitizeHtml from 'sanitize-html';
import { POLICIES, type PresetName, type SanitizePolicy } from './policies.js';

const FORBIDDEN_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'base',
  'meta',
  'link',
  'form',
  'input',
  'textarea',
  'select',
  'button',
  'noscript',
  'template',
]);
const FORBIDDEN_ATTRS = new Set(['style', 'srcdoc', 'formaction']);
const FORBIDDEN_SCHEMES = new Set(['javascript', 'vbscript', 'data']);

/** Throws TypeError if a policy would re-enable a known XSS vector. */
export function assertSafePolicy(policy: SanitizePolicy): void {
  for (const tag of policy.allowedTags) {
    if (FORBIDDEN_TAGS.has(tag.toLowerCase()))
      throw new TypeError(`Unsafe sanitize policy: tag <${tag}> cannot be allowed`);
  }
  for (const attrs of Object.values(policy.allowedAttributes)) {
    for (const attr of attrs) {
      // sanitize-html expands '*' globs, so 'o*' or '*' would match on* event handlers.
      if (attr.includes('*'))
        throw new TypeError(
          `Unsafe sanitize policy: attribute pattern "${attr}" cannot contain "*"; list attributes explicitly`,
        );
      const a = attr.toLowerCase();
      if (a.startsWith('on') || FORBIDDEN_ATTRS.has(a))
        throw new TypeError(`Unsafe sanitize policy: attribute "${attr}" cannot be allowed`);
    }
  }
  for (const scheme of policy.allowedSchemes ?? []) {
    if (FORBIDDEN_SCHEMES.has(scheme.toLowerCase()))
      throw new TypeError(`Unsafe sanitize policy: URL scheme "${scheme}" cannot be allowed`);
  }
}

/** Allowlist sanitization. Links always get rel="noopener noreferrer". */
export function sanitize(html: string, policy: SanitizePolicy | PresetName = 'basic'): string {
  const p = typeof policy === 'string' ? POLICIES[policy] : policy;
  assertSafePolicy(p);
  const allowedAttributes: Record<string, string[]> = {};
  for (const [tag, attrs] of Object.entries(p.allowedAttributes))
    allowedAttributes[tag] = [...attrs];
  if (p.allowedTags.includes('a')) allowedAttributes.a = [...(allowedAttributes.a ?? []), 'rel'];
  return sanitizeHtml(html, {
    allowedTags: [...p.allowedTags],
    allowedAttributes,
    allowedSchemes: [...(p.allowedSchemes ?? ['http', 'https', 'mailto'])],
    allowedSchemesByTag: {
      img: p.allowedSchemes ? p.allowedSchemes.filter((s) => s !== 'mailto') : ['http', 'https'],
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) },
  });
}
