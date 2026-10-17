import { join } from 'node:path';
import { defineConfig } from 'prisma/config';

// Used by `pnpm --filter @knead-js/prisma test:db`. `generate` needs no database; `db push`
// reads DATABASE_URL.
export default defineConfig({
  schema: join(import.meta.dirname, 'schema.prisma'),
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
