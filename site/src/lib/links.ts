import { resolve } from '$app/paths';

/** The href of a documentation page (`guide/modules`), with an optional `#fragment`. */
export function docHref(slug: string, hash?: string): string {
  const path = resolve('/[...slug]', { slug });
  return `${path.endsWith('/') ? path : `${path}/`}${hash ? `#${hash}` : ''}`;
}
