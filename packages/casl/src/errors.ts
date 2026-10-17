import { KneadError } from '@knead-js/core';

/** Invalid CASL configuration, raised at `definePermissions()` / `forRoot()`, never per request. */
export class CaslConfigError extends KneadError {}
