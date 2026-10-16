// Tokens, module metadata and inject() rely on module-level identity. Two copies of
// @knead/core (e.g. a nested install after a version mismatch) silently break them, so the
// first copy records itself on globalThis and any later, different copy warns once.

export interface CoreCopyMarker {
  readonly url: string;
}

/** @internal */
export const CORE_COPY_KEY: unique symbol = Symbol.for('hpmws.core');
/** @internal */
export const CORE_COPY_WARNED_KEY: unique symbol = Symbol.for('hpmws.core.duplicateWarned');

/** @internal Records this copy, or warns once if a different copy was loaded first. */
export function registerCoreCopy(marker: CoreCopyMarker): void {
  const store = globalThis as Record<symbol, unknown>;
  const existing = store[CORE_COPY_KEY] as CoreCopyMarker | undefined;
  if (existing === undefined) {
    store[CORE_COPY_KEY] = marker;
    return;
  }
  if (existing.url === marker.url || store[CORE_COPY_WARNED_KEY]) return;
  store[CORE_COPY_WARNED_KEY] = true;
  console.warn(
    `[hpmws] Multiple copies of @knead/core are loaded (${existing.url} and ${marker.url}). ` +
      'Injection tokens, module metadata and inject() will not work across them; ' +
      'make sure every @knead/* package resolves the same @knead/core (it is a peer dependency).',
  );
}

registerCoreCopy({ url: import.meta.url });
