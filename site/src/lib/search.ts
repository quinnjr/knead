export interface SearchEntry {
  slug: string;
  title: string;
  description: string;
  headings: { id: string; text: string }[];
  text: string;
}

export interface SearchResult {
  slug: string;
  /** Heading id to jump to, when the best match was a heading. */
  hash?: string;
  title: string;
  /** The page title when the result is a heading on that page. */
  context?: string;
  excerpt: string;
  score: number;
}

const MAX_RESULTS = 12;

function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}@/._-]+/u)
    .filter(Boolean)
    .slice(0, 8);
}

function excerpt(text: string, term: string): string {
  const at = text.toLowerCase().indexOf(term);
  if (at < 0) return '';
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + term.length + 90);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Ranks pages and headings for a query. Every term must occur somewhere in the page. */
export function search(entries: readonly SearchEntry[], query: string): SearchResult[] {
  const words = terms(query);
  if (!words.length) return [];
  const results: SearchResult[] = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    const description = entry.description.toLowerCase();
    const text = entry.text.toLowerCase();
    const headings = entry.headings.map((h) => h.text.toLowerCase());
    const everywhere = `${title} ${description} ${headings.join(' ')} ${text}`;
    if (!words.every((w) => everywhere.includes(w))) continue;

    let pageScore = 0;
    for (const w of words) {
      if (title === w) pageScore += 40;
      else if (title.includes(w)) pageScore += 20;
      if (description.includes(w)) pageScore += 6;
      if (text.includes(w)) pageScore += 1;
    }
    results.push({
      slug: entry.slug,
      title: entry.title,
      excerpt: entry.description,
      score: pageScore,
    });

    entry.headings.forEach((heading, i) => {
      const h = headings[i]!;
      const matched = words.filter((w) => h.includes(w)).length;
      if (!matched) return;
      results.push({
        slug: entry.slug,
        hash: heading.id,
        title: heading.text,
        context: entry.title,
        excerpt: excerpt(entry.text, words[0]!) || entry.description,
        score: matched * 12 + (matched === words.length ? 10 : 0) + pageScore / 4,
      });
    });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
}
