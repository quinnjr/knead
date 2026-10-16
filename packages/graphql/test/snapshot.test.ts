import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildSchema } from 'graphql';
import { printSortedSchema } from '../src/index.js';
import { BlogModule } from './fixtures/blog.js';
import { sdlOf } from './helpers.js';

const snapshot = join(import.meta.dir, 'fixtures/blog.graphql');

// Regenerate after an intentional schema change: UPDATE_SCHEMA_SNAPSHOT=1 bun test snapshot
// The committed file is re-printed before comparing, so formatter changes to it do not matter.
test('the blog fixture SDL matches the committed snapshot', async () => {
  const sdl = await sdlOf([BlogModule]);
  if (process.env.UPDATE_SCHEMA_SNAPSHOT === '1') await Bun.write(snapshot, sdl);
  expect(sdl).toBe(printSortedSchema(buildSchema(await Bun.file(snapshot).text())));
});
