import { renderPlayground } from '@leaven-graphql/playground';

export interface PlaygroundPage {
  readonly html: string;
  /** A CSP allowing exactly this page: its inline script by hash, its CDN assets by full URL. */
  readonly csp: string;
}

const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g;
const SCRIPT_SRC = /<script src="([^"]+)"/g;
const STYLESHEET = /<link\s+rel="stylesheet"\s+href="([^"]+)"/g;
const ICON = /<link\s+rel="shortcut icon"\s+href="([^"]+)"/g;

const urls = (html: string, pattern: RegExp) =>
  [...html.matchAll(pattern)].map((m) => m[1] ?? '').filter((u) => u.startsWith('https://'));

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('base64');
}

export function playgroundPage(endpoint: string, subscriptionEndpoint?: string): PlaygroundPage {
  const html = renderPlayground({ endpoint, subscriptionEndpoint, title: 'GraphQL Playground' });
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map((m) => `'sha256-${sha256(m[1] ?? '')}'`);
  // CDN sources are the exact asset URLs the page loads, not the whole CDN host.
  const csp = [
    "default-src 'self'",
    ['script-src', "'self'", ...urls(html, SCRIPT_SRC), ...hashes].join(' '),
    // The playground bundle injects styles at runtime, so inline styles cannot be hashed.
    [
      'style-src',
      "'self'",
      "'unsafe-inline'",
      ...urls(html, STYLESHEET),
      'https://fonts.googleapis.com',
    ].join(' '),
    "font-src 'self' data: https://fonts.gstatic.com",
    ['img-src', "'self'", 'data:', ...urls(html, ICON)].join(' '),
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
  return { html, csp };
}

export function playgroundResponse(page: PlaygroundPage): Response {
  return new Response(page.html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': page.csp,
    },
  });
}
