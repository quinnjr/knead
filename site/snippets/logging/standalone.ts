import { JsonLogger } from '@knead-js/logging';

/** A logger for a script that runs outside a Knead application. */
export const log = new JsonLogger({ name: 'reindex', level: 'warn' });
