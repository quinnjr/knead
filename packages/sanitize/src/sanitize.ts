import sanitizeHtml from 'sanitize-html';
import { POLICIES, type PresetName, type SanitizePolicy } from './policies.js';

/** Allowlist sanitization. Links always get rel="noopener noreferrer". */
export function sanitize(html: string, policy: SanitizePolicy | PresetName = 'basic'): string {
  const p = typeof policy === 'string' ? POLICIES[policy] : policy;
  const allowedAttributes: Record<string, string[]> = {};
  for (const [tag, attrs] of Object.entries(p.allowedAttributes))
    allowedAttributes[tag] = [...attrs];
  if (p.allowedTags.includes('a')) allowedAttributes.a = [...(allowedAttributes.a ?? []), 'rel'];
  return sanitizeHtml(html, {
    allowedTags: [...p.allowedTags],
    allowedAttributes,
    allowedSchemes: [...(p.allowedSchemes ?? ['http', 'https', 'mailto'])],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) },
  });
}
