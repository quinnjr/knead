import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { NAV } from '../src/lib/nav.js';
import {
  ContentError,
  includeSnippets,
  parseFrontmatter,
  renderPage,
} from '../src/lib/server/markdown.js';

const site = join(import.meta.dir, '..');
const repo = join(site, '..');

function walk(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => join(e.parentPath, e.name));
}

const pageFiles = walk(join(site, 'content'), '.md');
const pages = new Map(
  pageFiles.map((f) => [relative(join(site, 'content'), f).slice(0, -3), readFileSync(f, 'utf8')]),
);
const snippets = new Map(
  walk(join(site, 'snippets'), '.ts').map((f) => [
    relative(join(site, 'snippets'), f),
    readFileSync(f, 'utf8'),
  ]),
);

/** Resolves `/guide/x/` links the way the site does, failing on pages that do not exist. */
function href(path: string): string {
  if (path === '/') return '/';
  const slug = path.slice(1, -1);
  if (!pages.has(slug)) throw new ContentError(`link to missing page ${path}`);
  return path;
}

describe('navigation', () => {
  test('lists every content page exactly once', () => {
    const listed = NAV.flatMap((s) => s.slugs);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...pages.keys()].sort());
  });
});

describe('pages', () => {
  for (const [slug, source] of pages) {
    test(`${slug} renders`, async () => {
      const page = await renderPage(source, { snippets, href, file: `content/${slug}.md` });
      expect(page.html.length).toBeGreaterThan(0);
    });

    test(`${slug} has no inline TypeScript, placeholders or relative links`, () => {
      // TypeScript on the site comes only from typechecked files under snippets/.
      expect(source).not.toMatch(/^\s*(`{3,}|~{3,})\s*(ts|typescript|js|javascript|tsx)\b/m);
      expect(source).not.toMatch(/\b(?:TODO|TBD|FIXME|XXX)\b/);
      expect(source).not.toMatch(/lorem ipsum|\bstub\b/i);
      expect(source).not.toMatch(/\]\((?!https?:\/\/|\/|#)[^)]*\)/);
    });
  }
});

describe('snippets', () => {
  test('every snippet is included by some page', () => {
    const bodies =
      [...pages.values()].join('\n') +
      readFileSync(join(site, 'src/routes/+page.server.ts'), 'utf8');
    // snippets/readme/ holds the package READMEs' examples; readmes.test.ts checks those.
    const unused = [...snippets.keys()].filter(
      (path) => !path.startsWith('readme/') && !bodies.includes(`<<< ${path}`),
    );
    expect(unused).toEqual([]);
  });

  test('every region a page includes exists', () => {
    for (const [slug, source] of pages) {
      const { body } = parseFrontmatter(source, slug);
      expect(() => includeSnippets(body, snippets, slug)).not.toThrow();
    }
  });
});

describe('includeSnippets', () => {
  const files = new Map([
    [
      'a.ts',
      'import x from "x";\n// #region one\n  const a = 1;\n  // #region inner\n  const b = 2;\n  // #endregion inner\n// #endregion one\n',
    ],
  ]);

  test('includes a whole file without region markers', () => {
    const out = includeSnippets('<<< a.ts\n', files, 't');
    expect(out).toBe('```ts\nimport x from "x";\n  const a = 1;\n  const b = 2;\n```\n');
  });

  test('includes one region, dedented, with a title', () => {
    expect(includeSnippets('<<< a.ts#one title="app.ts"', files, 't')).toBe(
      '```ts title="app.ts"\nconst a = 1;\nconst b = 2;\n```',
    );
  });

  test('fails on a missing file or region', () => {
    expect(() => includeSnippets('<<< b.ts', files, 't')).toThrow(ContentError);
    expect(() => includeSnippets('<<< a.ts#two', files, 't')).toThrow(ContentError);
  });
});

describe('renderPage', () => {
  const render = (body: string) =>
    renderPage(`---\ntitle: T\ndescription: D.\n---\n${body}`, {
      snippets: new Map(),
      href,
      file: 't',
    });

  test('renders callouts, anchors and the table of contents', async () => {
    const page = await render('## First part\n\n> [!WARNING]\n> Careful.\n\n### Sub `code`\n');
    expect(page.html).toMatch(
      /<aside class="callout callout-warning"><p class="callout-title"><svg [^>]*aria-hidden="true"[^>]*>.*?<\/svg>Warning<\/p><p>Careful\.<\/p>/,
    );
    expect(page.html).toContain('<h2 id="first-part">');
    expect(page.toc).toEqual([
      { depth: 2, id: 'first-part', text: 'First part' },
      { depth: 3, id: 'sub-code', text: 'Sub code' },
    ]);
  });

  test('rejects broken content', async () => {
    await expect(render('# Title')).rejects.toThrow('h1');
    await expect(render('## A\n\n## A')).rejects.toThrow('duplicate');
    await expect(render('[x](guide/modules/)')).rejects.toThrow('absolute');
    await expect(render('[x](/guide/modules)')).rejects.toThrow('slash');
    await expect(render('[x](/guide/nope/)')).rejects.toThrow('missing page');
    await expect(render('```rust\nfn main() {}\n```')).rejects.toThrow('unsupported');
  });
});

/** Every name a package's entry point exports, types included. */
function exportsOf(pkg: string): string[] {
  const entry = join(repo, 'packages', pkg, 'src/index.ts');
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry)!;
  const symbol = checker.getSymbolAtLocation(source)!;
  return checker.getExportsOfModule(symbol).map((s) => s.getName());
}

describe('package reference pages', () => {
  const packages = readdirSync(join(repo, 'packages')).filter(
    (p) =>
      pages.has(`packages/${p}`) || readdirSync(join(repo, 'packages', p)).includes('package.json'),
  );

  test('every package has a reference page', () => {
    expect(packages.filter((p) => !pages.has(`packages/${p}`))).toEqual([]);
  });

  for (const pkg of packages) {
    test(`packages/${pkg} documents every export`, () => {
      const page = pages.get(`packages/${pkg}`) ?? '';
      const missing = exportsOf(pkg).filter(
        (name) => !new RegExp(`\`${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(page),
      );
      expect(missing).toEqual([]);
    });
  }
});
