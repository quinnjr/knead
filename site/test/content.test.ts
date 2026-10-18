import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Marked, type Tokens } from 'marked';
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

/** The text of every indented (not fenced) code block in a markdown body. */
function indentedCodeBlocks(body: string): string[] {
  const marked = new Marked({ gfm: true });
  const found: string[] = [];
  marked.walkTokens(marked.lexer(body), (token) => {
    if (token.type === 'code' && (token as Tokens.Code).codeBlockStyle === 'indented') {
      found.push(token.text);
    }
  });
  return found;
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
      // Indented code blocks have no language, so they could hide TypeScript from the check above.
      expect(indentedCodeBlocks(parseFrontmatter(source, slug).body)).toEqual([]);
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

  test('indented code blocks are found, fenced ones are not', () => {
    expect(indentedCodeBlocks('Text\n\n    const a: number = 1;\n\n```text\nok\n```\n')).toEqual([
      'const a: number = 1;',
    ]);
  });

  test('search text holds each piece of text once', async () => {
    const page = await render(
      '## Head\n\nSome **bold** text with `code`.\n\n- alpha item\n- beta item\n\n> quoted line\n\n| a | b |\n| --- | --- |\n| c | d |\n',
    );
    expect(page.text).toBe(
      'Head Some bold text with code . alpha item beta item quoted line a b c d',
    );
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

interface PackageApi {
  /** Every name the entry point exports, types included. */
  names: Set<string>;
  /** Static members of each exported value (`ConfigModule.forRoot`). */
  statics: Map<string, Set<string>>;
  /** Instance members of each exported class or interface. */
  members: Map<string, Set<string>>;
}

let apis: Map<string, PackageApi> | undefined;

/** The source file of one `exports` target: a path, or a conditions object naming one. */
function exportSource(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object') {
    const conditions = target as Record<string, unknown>;
    for (const key of ['bun', 'import', 'default', 'types']) {
      const found = exportSource(conditions[key]);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Every entry point a package exposes, from its package.json `exports` (which point at the
 * TypeScript sources; `publishConfig.exports` holds the published `dist/` paths), so subpath
 * exports such as `@knead-js/prisma/http` are checked along with the root.
 */
function packageEntries(pkg: string): string[] {
  const dir = join(repo, 'packages', pkg);
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { exports?: unknown };
  const map =
    typeof manifest.exports === 'string' || !manifest.exports
      ? { '.': manifest.exports ?? './src/index.ts' }
      : (manifest.exports as Record<string, unknown>);
  return Object.entries(map).map(([subpath, target]) => {
    const source = exportSource(target);
    if (!source || !/\.tsx?$/.test(source)) {
      throw new Error(`${pkg}: exports["${subpath}"] does not point at a TypeScript source`);
    }
    const entry = join(dir, source);
    if (!existsSync(entry)) throw new Error(`${pkg}: exports["${subpath}"] → missing ${source}`);
    return entry;
  });
}

/**
 * The public API of every package, from ONE program rooted at every entry point each package's
 * `exports` names (the root and every subpath), with the names of a package's entries merged.
 * A root that cannot resolve a module (TS2307) fails, instead of silently exporting less.
 */
function packageApis(): Map<string, PackageApi> {
  if (apis) return apis;
  const roots = readdirSync(join(repo, 'packages')).flatMap((pkg) =>
    packageEntries(pkg).map((entry) => [pkg, entry] as const),
  );
  const program = ts.createProgram(
    roots.map(([, entry]) => entry),
    {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
  );
  const checker = program.getTypeChecker();
  const unresolved: string[] = [];
  const result = new Map<string, PackageApi>();
  for (const [pkg, entry] of roots) {
    const source = program.getSourceFile(entry)!;
    for (const d of program.getSemanticDiagnostics(source)) {
      if (d.code === 2307)
        unresolved.push(`${pkg}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
    let api = result.get(pkg);
    if (!api) {
      api = { names: new Set(), statics: new Map(), members: new Map() };
      result.set(pkg, api);
    }
    for (const exported of checker.getExportsOfModule(checker.getSymbolAtLocation(source)!)) {
      const name = exported.getName();
      api.names.add(name);
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (symbol.flags & ts.SymbolFlags.Value) {
        const type = checker.getTypeOfSymbol(symbol);
        api.statics.set(name, new Set(type.getProperties().map((p) => p.getName())));
      }
      if (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) {
        const type = checker.getDeclaredTypeOfSymbol(symbol);
        api.members.set(name, new Set(checker.getPropertiesOfType(type).map((p) => p.getName())));
      }
    }
  }
  if (unresolved.length) throw new Error(`Unresolved modules:\n${unresolved.join('\n')}`);
  apis = result;
  return result;
}

const IDENT = '[A-Za-z_$][\\w$]*';
const DECLARATION = new RegExp(`^(?:class|interface|type|enum|function|const)\\s+(${IDENT})`);
const STATIC_CALL = new RegExp(`^(${IDENT})\\.(${IDENT})\\s*[<(]`);
const CALL = new RegExp(`^(${IDENT})\\s*[<(]`);
const MEMBER = new RegExp(`^\\s+(?:(?:readonly|static)\\s+)*(${IDENT})\\??\\s*[<(:]`);

/**
 * The API names a page's ```text signature blocks mention, each with what it must be: declared
 * names (`class Config<T> {`), calls (`defineConfig<S>(`, `ConfigModule.forRoot(`) and the
 * members listed inside a declared class or interface body.
 */
function signatureClaims(page: string): string[][] {
  const claims: string[][] = [];
  for (const m of page.matchAll(/^(`{3,})text[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm)) {
    let body: string | undefined;
    for (const line of m[2]!.split('\n')) {
      if (body !== undefined) {
        if (/^\}/.test(line)) body = undefined;
        else {
          const member = MEMBER.exec(line)?.[1];
          if (member && member !== 'constructor') claims.push(['member', body, member]);
        }
        continue;
      }
      const declared = DECLARATION.exec(line)?.[1];
      if (declared) {
        claims.push(['export', declared]);
        if (/\{\s*$/.test(line) && /^(?:class|interface)\b/.test(line)) body = declared;
        continue;
      }
      const call = STATIC_CALL.exec(line);
      if (call) claims.push(['static', call[1]!, call[2]!]);
      else if (CALL.test(line)) claims.push(['call', CALL.exec(line)![1]!]);
    }
  }
  return claims;
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
      const missing = [...packageApis().get(pkg)!.names].filter(
        (name) => !new RegExp(`\`${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(page),
      );
      expect(missing).toEqual([]);
    });

    test(`packages/${pkg} signature blocks name only what the package exports`, () => {
      const api = packageApis().get(pkg)!;
      const anyMember = (name: string) => [...api.members.values()].some((m) => m.has(name));
      const stale = signatureClaims(pages.get(`packages/${pkg}`) ?? '').filter(([kind, a, b]) => {
        if (kind === 'export') return !api.names.has(a!);
        if (kind === 'static') return !api.statics.get(a!)?.has(b!);
        if (kind === 'member') return !api.members.get(a!)?.has(b!);
        // A bare call is an exported function or a method of an exported class or interface.
        return !api.names.has(a!) && !anyMember(a!);
      });
      expect(stale).toEqual([]);
    });
  }

  test('subpath exports are part of their package API', () => {
    // @knead-js/prisma/http and @knead-js/prisma/testing are entry points of their own.
    expect(packageEntries('prisma').map((e) => relative(repo, e))).toEqual([
      'packages/prisma/src/index.ts',
      'packages/prisma/src/http/index.ts',
      'packages/prisma/src/testing/index.ts',
    ]);
    const names = packageApis().get('prisma')!.names;
    expect(names.has('PrismaModule')).toBe(true);
    expect(names.has('PrismaExceptionFilter')).toBe(true);
    expect(names.has('withRollback')).toBe(true);
  });

  test('signature blocks are recognized (the drift guard is not vacuous)', () => {
    const claims = packages.flatMap((pkg) => signatureClaims(pages.get(`packages/${pkg}`) ?? ''));
    expect(claims.length).toBeGreaterThan(30);
    expect(signatureClaims('```text\nclass Gone {\n  missing(): void;\n}\nX.y(a)\n```')).toEqual([
      ['export', 'Gone'],
      ['member', 'Gone', 'missing'],
      ['static', 'X', 'y'],
    ]);
  });
});
