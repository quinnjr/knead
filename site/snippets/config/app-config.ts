import { defineConfig } from '@knead-js/config';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

export const AppConfig = defineConfig(
  toStandardJsonSchema(
    v.object({
      // Environment variables are strings: parse numbers and booleans in the schema.
      port: v.optional(v.pipe(v.string(), v.toNumber(), v.integer()), '3000'),
      databaseUrl: v.pipe(v.string(), v.url()),
      jwtSecret: v.pipe(v.string(), v.minLength(32)),
      signupsOpen: v.optional(
        v.pipe(
          v.picklist(['true', 'false']),
          v.transform((value) => value === 'true'),
        ),
        'false',
      ),
    }),
  ),
  { name: 'AppConfig' },
);
