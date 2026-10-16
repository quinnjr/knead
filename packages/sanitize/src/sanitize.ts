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
  // Raw-text and legacy elements (parser differentials, mXSS) and embedding elements.
  'xmp',
  'noembed',
  'noframes',
  'plaintext',
  'title',
  'frame',
  'frameset',
  'applet',
  'portal',
]);
const FORBIDDEN_ATTRS = new Set(['style', 'srcdoc', 'formaction']);
const CLOBBERING_ATTRS = new Set(['id', 'name']);
const FORBIDDEN_SCHEMES = new Set(['javascript', 'vbscript', 'data']);
/** The scheme allowlist; `extraSchemes` extends it. */
const SAFE_SCHEMES = ['http', 'https', 'mailto', 'tel'] as const;
const SCHEME = /^[a-z][a-z0-9+.-]*$/;
/** Every attribute whose value is a URL, so schemes are checked on all of them. */
const URL_ATTRIBUTES = [
  'href',
  'src',
  'cite',
  'action',
  'background',
  'poster',
  'data',
  'xlink:href',
  'formaction',
  'ping',
];

/** Throws TypeError if a policy would re-enable a known XSS vector. */
export function assertSafePolicy(policy: SanitizePolicy): void {
  for (const tag of policy.allowedTags) {
    if (FORBIDDEN_TAGS.has(tag.toLowerCase()))
      throw new TypeError(`Unsafe sanitize policy: tag <${tag}> cannot be allowed`);
  }
  for (const attrs of Object.values(policy.allowedAttributes)) {
    for (const attr of attrs) {
      if (CLOBBERING_ATTRS.has(attr.toLowerCase()) && policy.allowClobberingAttributes !== true)
        throw new TypeError(
          `Unsafe sanitize policy: attribute "${attr}" can clobber DOM globals; set allowClobberingAttributes: true to allow it`,
        );
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
  for (const scheme of policy.extraSchemes ?? []) {
    if (FORBIDDEN_SCHEMES.has(scheme.toLowerCase()))
      throw new TypeError(`Unsafe sanitize policy: URL scheme "${scheme}" cannot be allowed`);
    if (!SCHEME.test(scheme.toLowerCase()))
      throw new TypeError(`Unsafe sanitize policy: "${scheme}" is not a URL scheme`);
  }
  const allowlist = new Set(schemeAllowlist(policy));
  for (const scheme of policy.allowedSchemes ?? []) {
    if (FORBIDDEN_SCHEMES.has(scheme.toLowerCase()))
      throw new TypeError(`Unsafe sanitize policy: URL scheme "${scheme}" cannot be allowed`);
    if (!allowlist.has(scheme.toLowerCase()))
      throw new TypeError(
        `Unsafe sanitize policy: URL scheme "${scheme}" is not on the allowlist (${[...allowlist].join(', ')}); add it to extraSchemes`,
      );
  }
}

function schemeAllowlist(policy: SanitizePolicy): string[] {
  return [...SAFE_SCHEMES, ...(policy.extraSchemes ?? []).map((s) => s.toLowerCase())];
}

/** Allowlist sanitization. Links always get rel="noopener noreferrer". */
export function sanitize(html: string, policy: SanitizePolicy | PresetName = 'basic'): string {
  const p = typeof policy === 'string' ? POLICIES[policy] : policy;
  assertSafePolicy(p);
  const allowedAttributes: Record<string, string[]> = {};
  for (const [tag, attrs] of Object.entries(p.allowedAttributes))
    allowedAttributes[tag] = [...attrs];
  if (p.allowedTags.includes('a')) allowedAttributes.a = [...(allowedAttributes.a ?? []), 'rel'];
  const schemes = (p.allowedSchemes ?? schemeAllowlist(p)).map((s) => s.toLowerCase());
  return sanitizeHtml(html, {
    allowedTags: [...p.allowedTags],
    allowedAttributes,
    allowedSchemes: schemes,
    allowedSchemesByTag: {
      img: p.allowedSchemes
        ? schemes.filter((s) => s !== 'mailto' && s !== 'tel')
        : ['http', 'https'],
    },
    allowedSchemesAppliedToAttributes: [...URL_ATTRIBUTES],
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) },
  });
}
