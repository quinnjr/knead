import { Marked, type Tokens } from 'marked';
import { createHighlighter, type Highlighter } from 'shiki';
import { type ICONS, icon } from './icons.js';

/** Languages a fenced block may use. TypeScript comes only from snippets (see `includeSnippets`). */
export const LANGUAGES = [
  'ts',
  'bash',
  'json',
  'text',
  'graphql',
  'prisma',
  'yaml',
  'http',
  'diff',
] as const;

export interface Frontmatter {
  title: string;
  description: string;
}

export interface TocEntry {
  depth: 2 | 3;
  id: string;
  text: string;
}

export interface RenderedPage extends Frontmatter {
  html: string;
  /** The page's h2 and h3 headings. */
  toc: TocEntry[];
  /** Plain text of the page, for search. */
  text: string;
}

export class ContentError extends Error {
  override name = 'ContentError';
}

/** Parses the `---` block at the top of a page. Only `title` and `description` are allowed. */
export function parseFrontmatter(
  source: string,
  file: string,
): { meta: Frontmatter; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) throw new ContentError(`${file}: missing frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const sep = line.indexOf(':');
    if (sep < 1) throw new ContentError(`${file}: bad frontmatter line ${JSON.stringify(line)}`);
    const key = line.slice(0, sep).trim();
    if (key !== 'title' && key !== 'description') {
      throw new ContentError(`${file}: unknown frontmatter key ${JSON.stringify(key)}`);
    }
    fields[key] = line.slice(sep + 1).trim();
  }
  if (!fields.title) throw new ContentError(`${file}: frontmatter needs a title`);
  if (!fields.description) throw new ContentError(`${file}: frontmatter needs a description`);
  return {
    meta: { title: fields.title, description: fields.description },
    body: source.slice(match[0].length),
  };
}

const INCLUDE = /^<<< ([\w./-]+\.ts)(?:#([\w-]+))?(?: title="([^"]+)")?[ \t]*$/gm;
const REGION_MARKER = /^[ \t]*\/\/ #(?:end)?region\b.*$\n?/gm;

/**
 * Replaces each `<<< path.ts#region title="name.ts"` line with a fenced TypeScript block holding
 * that snippet (or one `// #region name` … `// #endregion name` part of it). Region markers are
 * removed from the output and the region is dedented.
 */
export function includeSnippets(
  body: string,
  snippets: ReadonlyMap<string, string>,
  file: string,
): string {
  return body.replace(INCLUDE, (_line, path: string, region?: string, title?: string) => {
    const source = snippets.get(path);
    if (source === undefined) throw new ContentError(`${file}: no snippet ${path}`);
    const code = snippetCode(source, region);
    if (code === undefined)
      throw new ContentError(`${file}: no region ${region} in snippet ${path}`);
    if (!code)
      throw new ContentError(`${file}: snippet ${path}${region ? `#${region}` : ''} is empty`);
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1));
    return `${fence}ts${title ? ` title="${title}"` : ''}\n${code}\n${fence}`;
  });
}

/**
 * The code a page shows for a snippet, or one `// #region name` of it: region markers removed,
 * dedented and trimmed. `undefined` when the region does not exist.
 */
export function snippetCode(source: string, region?: string): string | undefined {
  let code = source;
  if (region) {
    const start = new RegExp(`^[ \\t]*// #region ${region}[ \\t]*$`, 'm').exec(source);
    const end = new RegExp(`^[ \\t]*// #endregion ${region}[ \\t]*$`, 'm').exec(source);
    if (!start || !end || end.index < start.index) return undefined;
    code = source.slice(start.index + start[0].length + 1, end.index);
  }
  return dedent(code.replace(REGION_MARKER, '')).trim();
}

/** Every region name defined in a snippet. */
export function snippetRegions(source: string): string[] {
  return [...source.matchAll(/^[ \t]*\/\/ #region ([\w-]+)[ \t]*$/gm)].map((m) => m[1]!);
}

function dedent(code: string): string {
  const lines = code.split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join('\n');
}

function longestBacktickRun(code: string): number {
  let longest = 0;
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;|&#\d+;/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const CALLOUTS = {
  NOTE: ['Note', 'info'],
  TIP: ['Tip', 'lightbulb'],
  IMPORTANT: ['Important', 'important'],
  WARNING: ['Warning', 'warning'],
  CAUTION: ['Caution', 'caution'],
} as const satisfies Record<string, readonly [string, keyof typeof ICONS]>;

const LANGUAGE_LABELS: Record<string, string> = {
  ts: 'TypeScript',
  bash: 'Terminal',
  json: 'JSON',
  text: 'Output',
  graphql: 'GraphQL',
  prisma: 'Prisma',
  yaml: 'YAML',
  http: 'HTTP',
  diff: 'Diff',
};

const COPY_BUTTON = `<button class="copy" type="button" aria-label="Copy code">${icon('copy', 'icon-copy')}${icon('check', 'icon-done')}<span class="copy-label">Copy</span></button>`;

let highlighter: Promise<Highlighter> | undefined;

function getHighlighter(): Promise<Highlighter> {
  highlighter ??= createHighlighter({
    themes: ['vitesse-light', 'vitesse-dark'],
    langs: [...LANGUAGES],
  });
  return highlighter;
}

export interface RenderOptions {
  /** Snippet sources keyed by their path under `snippets/`. */
  snippets: ReadonlyMap<string, string>;
  /** Turns a site path (`/guide/modules/#providers`) into an href. */
  href: (path: string) => string;
  /** File name, for error messages. */
  file: string;
}

/** Renders one content page. Throws ContentError on anything that would publish a broken page. */
export async function renderPage(source: string, options: RenderOptions): Promise<RenderedPage> {
  const { meta, body } = parseFrontmatter(source, options.file);
  return { ...meta, ...(await renderMarkdown(body, options)) };
}

/** Renders markdown without frontmatter (page bodies and fragments such as the home page's). */
export async function renderMarkdown(
  body: string,
  options: RenderOptions,
): Promise<Omit<RenderedPage, keyof Frontmatter>> {
  const { file } = options;
  const markdown = includeSnippets(body, options.snippets, file);
  const shiki = await getHighlighter();
  const headings: TocEntry[] = [];
  const ids = new Set<string>();
  const text: string[] = [];

  const callouts = new WeakMap<Tokens.Blockquote, keyof typeof CALLOUTS>();
  // GitHub-style `> [!NOTE]` callouts: strip the marker and remember the kind for the renderer.
  const markCallout = (quote: Tokens.Blockquote) => {
    const paragraph = quote.tokens[0];
    if (paragraph?.type !== 'paragraph') return;
    const first = (paragraph as Tokens.Paragraph).tokens[0];
    if (first?.type !== 'text') return;
    const marker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/.exec(first.raw);
    if (!marker) return;
    callouts.set(quote, marker[1] as keyof typeof CALLOUTS);
    const text = first as Tokens.Text;
    text.raw = text.raw.slice(marker[0].length);
    text.text = text.text.replace(/^\[!\w+\][ \t]*\n?/, '');
    if (text.tokens) {
      const inner = text.tokens[0];
      if (inner && 'text' in inner) {
        inner.raw = inner.raw.replace(/^\[!\w+\][ \t]*\n?/, '');
        inner.text = inner.text.replace(/^\[!\w+\][ \t]*\n?/, '');
      }
    }
  };

  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(token) {
      if (token.type === 'blockquote') markCallout(token as Tokens.Blockquote);
      // Only leaf text: a list item's block-level text token also holds inline children, which
      // walkTokens visits too, so pushing both would index the item twice.
      if (token.type === 'text' && !(token as Tokens.Text).tokens?.length) text.push(token.text);
      if (token.type === 'codespan' || token.type === 'escape') text.push(token.text);
      if (token.type === 'code') text.push(token.text);
    },
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        if (depth === 1) throw new ContentError(`${file}: use the frontmatter title, not an h1`);
        const id = slugify(inner);
        if (!id) throw new ContentError(`${file}: heading ${JSON.stringify(inner)} has no id`);
        if (ids.has(id)) throw new ContentError(`${file}: duplicate heading id ${id}`);
        ids.add(id);
        if (depth === 2 || depth === 3) {
          headings.push({ depth, id, text: inner.replace(/<[^>]*>/g, '') });
        }
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h${depth}>\n`;
      },
      code({ text: code, lang: info }: Tokens.Code) {
        const [lang = 'text', ...rest] = (info ?? '').trim().split(/\s+/);
        if (!(LANGUAGES as readonly string[]).includes(lang)) {
          throw new ContentError(`${file}: unsupported code language ${JSON.stringify(lang)}`);
        }
        const title = /title="([^"]+)"/.exec(rest.join(' '))?.[1];
        const html = shiki.codeToHtml(code, {
          lang,
          themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
          defaultColor: false,
        });
        const label = title
          ? `<span class="code-title">${escapeHtml(title)}</span>`
          : `<span class="code-lang">${LANGUAGE_LABELS[lang] ?? lang}</span>`;
        return `<div class="code-block" data-lang="${lang}"><div class="code-head">${label}${COPY_BUTTON}</div>${html}</div>\n`;
      },
      blockquote(token: Tokens.Blockquote) {
        const kind = callouts.get(token);
        const body = this.parser.parse(token.tokens);
        if (!kind) return `<blockquote>${body}</blockquote>\n`;
        const [title, symbol] = CALLOUTS[kind];
        return `<aside class="callout callout-${kind.toLowerCase()}"><p class="callout-title">${icon(symbol)}${title}</p>${body}</aside>\n`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        if (/^https?:\/\//.test(href)) {
          return `<a href="${escapeHtml(href)}"${titleAttr} rel="noreferrer">${inner}</a>`;
        }
        if (href.startsWith('#')) return `<a href="${escapeHtml(href)}"${titleAttr}>${inner}</a>`;
        if (!href.startsWith('/')) {
          throw new ContentError(`${file}: link ${href} must be absolute (/guide/…) or external`);
        }
        const [path = '', hash] = href.split('#');
        if (!path.endsWith('/')) {
          throw new ContentError(`${file}: internal link ${href} must end with a slash`);
        }
        return `<a href="${escapeHtml(options.href(path) + (hash ? `#${hash}` : ''))}"${titleAttr}>${inner}</a>`;
      },
      table(token: Tokens.Table) {
        const cell = (c: Tokens.TableCell, tag: 'th' | 'td') =>
          `<${tag}${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        const head = `<tr>${token.header.map((c) => cell(c, 'th')).join('')}</tr>`;
        const rows = token.rows.map((r) => `<tr>${r.map((c) => cell(c, 'td')).join('')}</tr>`);
        return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>\n`;
      },
    },
  });
  const html = await marked.parse(markdown, { async: true });
  return {
    html,
    toc: headings,
    text: text.join(' ').replace(/\s+/g, ' ').trim(),
  };
}
