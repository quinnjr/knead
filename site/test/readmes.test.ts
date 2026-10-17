// The package READMEs are what npmjs.com shows. Their TypeScript examples must be exact copies of
// typechecked snippets, and their links must work on npm, where relative links break.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { slugify, snippetCode, snippetRegions } from '../src/lib/server/markdown.js';

const site = join(import.meta.dir, '..');
const packagesDir = join(site, '..', 'packages');
const DOCS = 'https://quinnjr.github.io/knead';

const snippetFiles = readdirSync(join(site, 'snippets'), { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.ts'))
  .map((e) => join(e.parentPath, e.name));

/** Every block a page could show: each snippet whole and each of its regions, keyed by origin. */
const shown = new Map<string, string>();
for (const file of snippetFiles) {
  const source = readFileSync(file, 'utf8');
  const path = relative(join(site, 'snippets'), file);
  shown.set(snippetCode(source)!, path);
  for (const region of snippetRegions(source)) {
    const code = snippetCode(source, region);
    if (code) shown.set(code, `${path}#${region}`);
  }
}

const packages = readdirSync(packagesDir).filter((p) =>
  readdirSync(join(packagesDir, p)).includes('package.json'),
);
const readmes = new Map(
  packages.map((p) => [p, readFileSync(join(packagesDir, p, 'README.md'), 'utf8')]),
);

/** The fenced code blocks of a markdown document, with their info strings. */
function fences(markdown: string): { lang: string; code: string }[] {
  const out: { lang: string; code: string }[] = [];
  const re = /^(`{3,})([^\n`]*)\n([\s\S]*?)\n\1[ \t]*$/gm;
  for (const m of markdown.matchAll(re)) out.push({ lang: m[2]!.trim(), code: m[3]! });
  return out;
}

/** Markdown with fenced code removed, so links are only looked for in prose. */
function prose(markdown: string): string {
  return markdown.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '');
}

describe('package READMEs', () => {
  for (const [pkg, readme] of readmes) {
    describe(`@knead-js/${pkg}`, () => {
      test('starts with the package name and links its documentation page', () => {
        expect(readme.split('\n')[0]).toBe(`# @knead-js/${pkg}`);
        expect(readme).toContain(`${DOCS}/packages/${pkg}/`);
      });

      test('shows how to install it', () => {
        expect(readme).toMatch(new RegExp(`^bun add (-d )?.*@knead-js/${pkg}\\b`, 'm'));
      });

      test('TypeScript examples are exact copies of typechecked snippets', () => {
        for (const { lang, code } of fences(readme)) {
          if (!['ts', 'typescript', 'js', 'javascript', 'tsx'].includes(lang.split(/\s/)[0]!)) {
            continue;
          }
          expect(lang).toBe('ts');
          if (!shown.has(code.trim())) {
            throw new Error(`README example is not a snippet region:\n${code.slice(0, 400)}`);
          }
        }
      });

      test('links are absolute or point at a heading in the README', () => {
        const ids = new Set(
          [...readme.matchAll(/^#{2,6} (.+)$/gm)].map((m) => slugify(m[1]!.replace(/`/g, ''))),
        );
        for (const [, target] of prose(readme).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
          if (/^https:\/\//.test(target!)) continue;
          expect(target!.startsWith('#')).toBe(true);
          expect(ids).toContain(target!.slice(1));
        }
        expect(prose(readme)).not.toMatch(/<img\s[^>]*src="(?!https:\/\/)/);
      });

      test('docs links point at pages that exist', () => {
        for (const [, path] of readme.matchAll(
          /https:\/\/quinnjr\.github\.io\/knead(\/[^)\s#"]*)/g,
        )) {
          if (path === '/') continue;
          expect(path!.endsWith('/')).toBe(true);
          const slug = path!.slice(1, -1);
          expect(readdirSync(join(site, 'content', slug.split('/')[0]!))).toContain(
            `${slug.split('/')[1]}.md`,
          );
        }
      });
    });
  }

  test('every snippets/readme/ file is used by a README', () => {
    const blocks = new Set(
      [...readmes.values()].flatMap((r) => fences(r).map((f) => f.code.trim())),
    );
    const used = new Set(
      [...shown].filter(([code]) => blocks.has(code)).map(([, from]) => from.split('#')[0]),
    );
    const readmeSnippets = snippetFiles
      .map((f) => relative(join(site, 'snippets'), f))
      .filter((p) => p.startsWith('readme/'));
    expect(readmeSnippets.filter((p) => !used.has(p))).toEqual([]);
  });
});
