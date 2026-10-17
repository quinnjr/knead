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

/**
 * An index of route patterns for the fallback's 405 detection: a lookup runs only the matchers
 * that can accept the path, and returns the values of those that do, in insertion order. A
 * pattern without `*` matches only paths with as many `/` as it has (and, when its first segment
 * is static, only paths starting with that segment); one with `*` needs at least as many `/`.
 */
export function compilePathIndex<T>(
  entries: Iterable<readonly [string, T]>,
): (pathname: string) => T[] {
  interface Item {
    readonly order: number;
    readonly matcher: RegExp;
    readonly value: T;
  }
  const exact = new Map<string, Item[]>();
  const wildcards: { slashes: number; item: Item }[] = [];
  let order = 0;
  for (const [path, value] of entries) {
    const item: Item = { order: order++, matcher: compileMatcher(path), value };
    const segments = path.split('/');
    const slashes = segments.length - 1;
    if (segments.includes('*')) {
      wildcards.push({ slashes, item });
      continue;
    }
    const first = segments[1] ?? '';
    const key = first.startsWith(':') ? `${slashes}:` : `${slashes}/${first}`;
    const bucket = exact.get(key);
    if (bucket) bucket.push(item);
    else exact.set(key, [item]);
  }
  return (pathname) => {
    let slashes = 0;
    for (let i = pathname.indexOf('/'); i !== -1; i = pathname.indexOf('/', i + 1)) slashes++;
    const end = pathname.indexOf('/', 1);
    const first = pathname.slice(1, end === -1 ? undefined : end);
    const found: Item[] = [];
    const test = (items: readonly Item[] | undefined) => {
      if (items) for (const item of items) if (item.matcher.test(pathname)) found.push(item);
    };
    test(exact.get(`${slashes}/${first}`));
    test(exact.get(`${slashes}:`));
    for (const { slashes: min, item } of wildcards) {
      if (slashes >= min && item.matcher.test(pathname)) found.push(item);
    }
    return found.sort((a, b) => a.order - b.order).map((item) => item.value);
  };
}
