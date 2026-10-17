import { resolve } from '$app/paths';
import { docHref } from '../links.js';
import { NAV, type NavLink, type NavSection } from '../nav.js';
import { type RenderedPage, renderMarkdown, renderPage } from './markdown.js';

const pages = import.meta.glob<string>('/content/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const snippetFiles = import.meta.glob<string>('/snippets/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const snippets = new Map(
  Object.entries(snippetFiles).map(([path, source]) => [path.slice('/snippets/'.length), source]),
);

const sources = new Map(
  Object.entries(pages).map(([path, source]) => [
    path.slice('/content/'.length, -'.md'.length),
    source,
  ]),
);

/** A site path such as `/guide/modules/` as an href under the configured base path. */
export function href(path: string): string {
  if (path === '/') return resolve('/');
  const slug = path.slice(1, -1);
  if (!sources.has(slug)) throw new Error(`link to ${path}, but content/${slug}.md does not exist`);
  return docHref(slug);
}

const rendered = new Map<string, Promise<RenderedPage>>();

export function slugs(): string[] {
  return [...sources.keys()];
}

export function getPage(slug: string): Promise<RenderedPage> | undefined {
  const source = sources.get(slug);
  if (source === undefined) return undefined;
  let page = rendered.get(slug);
  if (!page) {
    page = renderPage(source, { snippets, href, file: `content/${slug}.md` });
    rendered.set(slug, page);
  }
  return page;
}

export async function getNav(): Promise<NavSection[]> {
  return Promise.all(
    NAV.map(async (section) => ({
      title: section.title,
      links: await Promise.all(
        section.slugs.map(async (slug): Promise<NavLink> => {
          const page = getPage(slug);
          if (!page) throw new Error(`nav lists ${slug} but content/${slug}.md does not exist`);
          return { slug, title: (await page).title };
        }),
      ),
    })),
  );
}

/** Renders a markdown fragment (used by the home page). */
export async function renderFragment(markdown: string, file: string): Promise<string> {
  return (await renderMarkdown(markdown, { snippets, href, file })).html;
}
