import { error } from '@sveltejs/kit';
import { getPage, slugs } from '#lib/server/content.js';
import type { EntryGenerator, PageServerLoad } from './$types';

export const entries: EntryGenerator = () => slugs().map((slug) => ({ slug }));

export const load: PageServerLoad = async ({ params }) => {
  // With trailingSlash: 'always' the rest parameter keeps the final slash.
  const slug = params.slug.replace(/\/$/, '');
  const page = getPage(slug);
  if (!page) error(404, 'Not found');
  const { title, description, html, toc } = await page;
  return { slug, title, description, html, toc };
};
