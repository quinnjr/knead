import { InjectionToken } from '@knead-js/core';
import type { FilterRef, GlobalMiddleware, GuardRef } from './types.js';

/** Multi-provider: global middleware contributed by modules (e.g. CORS). */
export const APP_MIDDLEWARE = new InjectionToken<GlobalMiddleware[]>('APP_MIDDLEWARE');
/** Multi-provider: guards applied to every route. */
export const APP_GUARD = new InjectionToken<GuardRef[]>('APP_GUARD');
/** Multi-provider: exception filters applied after route and controller filters. */
export const APP_FILTER = new InjectionToken<FilterRef[]>('APP_FILTER');
/**
 * The application's resolved development flag (`KneadFactory.create(root, { development })`,
 * default `NODE_ENV === 'development'`), injectable from any module.
 */
export const HTTP_DEVELOPMENT = new InjectionToken<boolean>('HTTP_DEVELOPMENT');
