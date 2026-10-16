/** Joins path parts into a normalized absolute path without a trailing slash. */
export function joinPaths(...parts: string[]): string {
  const segments = parts.flatMap((p) => p.split('/')).filter((s) => s.length > 0);
  return `/${segments.join('/')}`;
}

/** The route's shape with parameter names erased, used to detect conflicting routes. */
export function routeShape(path: string): string {
  return path.replace(/:[^/]+/g, ':');
}

/** A regex matching concrete request paths for a route pattern (fallback 405 detection). */
export function compileMatcher(path: string): RegExp {
  const pattern = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return '[^/]+';
      if (segment === '*') return '.*';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${pattern}$`);
}
