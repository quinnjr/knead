import { json } from '@sveltejs/kit';
import type { SearchEntry } from '#lib/search.js';
import { getPage, slugs } from '#lib/server/content.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  const entries: SearchEntry[] = await Promise.all(
    slugs().map(async (slug) => {
      const page = await getPage(slug)!;
      return {
        slug,
        title: page.title,
        description: page.description,
        headings: page.toc.map(({ id, text }) => ({ id, text })),
        text: page.text,
      };
    }),
  );
  return json(entries);
};
