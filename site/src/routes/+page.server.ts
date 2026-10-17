import { renderFragment } from '#lib/server/content.js';
import type { PageServerLoad } from './$types';

const FILE = 'routes/+page.server.ts';

/** The hero's code tabs: the getting-started app, as typechecked and tested snippets. */
const TABS = [
  { name: 'todos.controller.ts', include: '<<< start/todos.controller.ts' },
  { name: 'todos.service.ts', include: '<<< start/todos.service.ts' },
  { name: 'todos.test.ts', include: '<<< start/todos.test.ts' },
  { name: 'main.ts', include: '<<< start/main.ts' },
] as const;

export const load: PageServerLoad = async () => ({
  tabs: await Promise.all(
    TABS.map(async ({ name, include }) => ({
      name,
      html: await renderFragment(`${include}\n`, FILE),
    })),
  ),
});
