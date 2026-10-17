import { join } from 'node:path';
import { defineConfig } from 'prisma/config';

// Used by `pnpm --filter @knead-js/prisma test:db`. `generate` needs no database; `db push`
// reads KNEAD_PRISMA_TEST_DATABASE_URL (never DATABASE_URL, which may name a real database).
export default defineConfig({
  schema: join(import.meta.dirname, 'schema.prisma'),
  datasource: { url: process.env.KNEAD_PRISMA_TEST_DATABASE_URL ?? '' },
});
