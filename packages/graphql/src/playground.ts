import type { Logger } from '@knead-js/http';
import { renderPlayground } from '@leaven-graphql/playground';

/**
 * Subresource Integrity hashes of the CDN assets Leaven's playground page loads. Exact jsdelivr
 * npm versions are immutable. When Leaven changes these URLs the playground refuses to render
 * until the new URLs are added here (test/playground.test.ts fails first).
 * Computed with: curl -sSfL <url> | openssl dgst -sha384 -binary | base64
 *
 * These match @leaven-graphql/playground 0.2.2 (graphql-playground-react 1.7.28, which fixes
 * CVE-2021-41249). Recompute them whenever the playground dependency changes.
 */
export const PLAYGROUND_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  'https://cdn.jsdelivr.net/npm/graphql-playground-react@1.7.28/build/static/js/middleware.js':
    'sha384-ardaO17esJ2ZxvY24V1OE6X4j+Z3WKgGMptrlDLmD+2w/JC3nbQ5ZfKGY2zfOPEE',
  'https://cdn.jsdelivr.net/npm/graphql-playground-react@1.7.28/build/static/css/index.css':
    'sha384-xb+UHILNN4fV3NgQMTjXk0x9A80U0hmkraTFvucUYTILJymGT8E1Aq2278NSi5+3',
  'https://cdn.jsdelivr.net/npm/graphql-playground-react@1.7.28/build/favicon.png':
    'sha384-VLp5/okq5I2SPX4Uw0U/e4NV26ySLulHMNoG1Tql7c51MjUKtgTFKFTuVd3fjR2q',
});

/**
 * sha256 (base64) of each inline script in Leaven's playground page rendered for the reference
 * endpoint `/graphql` with no subscription endpoint (PLAYGROUND_REFERENCE). The gate renders that
 * page at bootstrap and refuses to serve the playground when the hashes differ, so a changed
 * Leaven template (or a tampered install) is noticed before it reaches a browser. Recompute with
 * `playgroundScriptHashes()` whenever the playground dependency changes.
 */
export const PLAYGROUND_SCRIPT_HASHES: readonly string[] = Object.freeze([
  'KXClm84BZMGQwvs58xNH4U6eMcSJLu9b0rCfFTanBU0=',
]);

/** The endpoint the pinned script hashes are computed for. */
export const PLAYGROUND_REFERENCE = '/graphql';

export interface PlaygroundPage {
  readonly html: string;
  /** A CSP allowing exactly this page: its inline script by hash, its CDN assets by full URL. */
  readonly csp: string;
}

/** Leaven's page references an external asset that has no pinned integrity hash. */
export class PlaygroundAssetError extends Error {
  constructor(readonly urls: readonly string[]) {
    super(`GraphQL playground assets have no pinned integrity hash: ${urls.join(', ')}`);
    this.name = 'PlaygroundAssetError';
  }
}

const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g;

/** Leaven's inline scripts do not match PLAYGROUND_SCRIPT_HASHES. */
export class PlaygroundScriptError extends Error {
  constructor(readonly hashes: readonly string[]) {
    super(
      `GraphQL playground inline scripts do not match the pinned hashes (got ${hashes.join(', ') || 'none'})`,
    );
    this.name = 'PlaygroundScriptError';
  }
}

/** The sha256 (base64) of each inline script of Leaven's reference playground page. */
export function playgroundScriptHashes(): string[] {
  const html = renderPlayground({ endpoint: PLAYGROUND_REFERENCE, title: 'GraphQL Playground' });
  return [...html.matchAll(INLINE_SCRIPT)].map((m) => sha256(m[1] ?? ''));
}
const SCRIPT_SRC = /<script src="([^"]+)"/g;
const STYLESHEET = /(<link\s+rel="stylesheet"\s+href="([^"]+)")/g;
const ICON = /<link\s+rel="shortcut icon"\s+href="([^"]+)"/g;
const EXTERNAL = /(?:src|href)="(https:\/\/[^"]+)"/g;

const urls = (html: string, pattern: RegExp, group = 1) =>
  [...html.matchAll(pattern)].map((m) => m[group] ?? '').filter((u) => u.startsWith('https://'));

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('base64');
}

/** Adds integrity and crossorigin to script and stylesheet tags; throws if a hash is missing. */
function withIntegrity(html: string, assets: Readonly<Record<string, string>>): string {
  const missing = urls(html, EXTERNAL).filter((url) => !Object.hasOwn(assets, url));
  if (missing.length > 0) throw new PlaygroundAssetError([...new Set(missing)]);
  const attrs = (url: string) => ` integrity="${assets[url]}" crossorigin="anonymous"`;
  return html
    .replace(SCRIPT_SRC, (tag, url: string) => `${tag}${attrs(url)}`)
    .replace(STYLESHEET, (tag, _all: string, url: string) => `${tag}${attrs(url)}`);
}

export function playgroundPage(
  endpoint: string,
  subscriptionEndpoint?: string,
  assets: Readonly<Record<string, string>> = PLAYGROUND_ASSETS,
): PlaygroundPage {
  const rendered = renderPlayground({
    endpoint,
    subscriptionEndpoint,
    title: 'GraphQL Playground',
  });
  const html = withIntegrity(rendered, assets);
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map((m) => `'sha256-${sha256(m[1] ?? '')}'`);
  // CDN sources are the exact asset URLs the page loads, not the whole CDN host.
  const csp = [
    "default-src 'self'",
    ['script-src', "'self'", ...urls(html, SCRIPT_SRC), ...hashes].join(' '),
    // The playground bundle injects styles at runtime, so inline styles cannot be hashed.
    ['style-src', "'self'", "'unsafe-inline'", ...urls(html, STYLESHEET, 2)].join(' '),
    // No third-party font hosts (Google Fonts would learn of every visit): system fonts.
    "font-src 'self' data:",
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
      'x-content-type-options': 'nosniff',
      'content-security-policy': page.csp,
      'referrer-policy': 'no-referrer',
    },
  });
}

/**
 * Serves the playground. The pinned asset and inline-script hashes are checked once, when the
 * gate is created at bootstrap: if Leaven's page references an asset without one, or its inline
 * scripts differ from PLAYGROUND_SCRIPT_HASHES, that is logged once and every request gets 503.
 */
export class PlaygroundGate {
  readonly #assets: Readonly<Record<string, string>>;
  readonly #available: boolean;

  constructor(
    logger: Logger,
    assets: Readonly<Record<string, string>> = PLAYGROUND_ASSETS,
    scriptHashes: readonly string[] = PLAYGROUND_SCRIPT_HASHES,
  ) {
    this.#assets = assets;
    try {
      playgroundPage(PLAYGROUND_REFERENCE, undefined, assets);
      const actual = playgroundScriptHashes();
      if (actual.length !== scriptHashes.length || actual.some((h, i) => h !== scriptHashes[i])) {
        throw new PlaygroundScriptError(actual);
      }
      this.#available = true;
    } catch (error) {
      if (error instanceof PlaygroundAssetError) {
        logger.error(
          `${error.message}. The playground is disabled; add them to PLAYGROUND_ASSETS.`,
        );
      } else if (error instanceof PlaygroundScriptError) {
        logger.error(
          `${error.message}. The playground is disabled; review Leaven's page and update ` +
            'PLAYGROUND_SCRIPT_HASHES.',
        );
      } else throw error;
      this.#available = false;
    }
  }

  get available(): boolean {
    return this.#available;
  }

  serve(endpoint: string, subscriptionEndpoint?: string): Response {
    if (!this.#available) {
      return new Response('GraphQL playground unavailable', {
        status: 503,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    return playgroundResponse(playgroundPage(endpoint, subscriptionEndpoint, this.#assets));
  }
}
