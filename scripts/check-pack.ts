// Packs every publishable package, checks the tarball contents, then installs the tarballs into
// a throwaway consumer project that typechecks and boots a small app. Exits 1 on any problem.
//
//   bun scripts/check-pack.ts                    pack into a temporary directory, check, delete
//   bun scripts/check-pack.ts --tarballs <dir>   check the tarballs already in <dir> (written by
//                                                `bun scripts/release.ts pack <dir>`) instead of
//                                                packing; <dir> is only read, never modified
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { exportTargets, listTarball, loadPublishRules, publishProblems } from './publish-rules.js';

const root = join(import.meta.dir, '..');
const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
  if (r.exitCode !== 0)
    throw new Error(`${cmd.join(' ')} failed:\n${r.stdout.toString()}${r.stderr.toString()}`);
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

// Every tarball also needs the files its published `exports` map points at (each subpath's
// `types` and `default`), read from the manifest's publishConfig.exports.
const required = ['LICENSE-MIT', 'LICENSE-APACHE', 'README.md'];
// The rules the release workflow's publish job applies, checked here on the real tarballs.
const publishRules = loadPublishRules(join(root, '.github/workflows/release.yml'));
const forbidden = [/\.map$/, /\.tsbuildinfo$/, /\/src\//, /\/test\//];
const problems: string[] = [];
const args = process.argv.slice(2);
let tarballDir: string | undefined;
if (args.length === 2 && args[0] === '--tarballs' && args[1]) {
  tarballDir = resolve(args[1]);
  if (!existsSync(tarballDir)) {
    console.error(`check-pack: ${tarballDir} does not exist`);
    process.exit(2);
  }
} else if (args.length > 0) {
  console.error('usage: bun scripts/check-pack.ts [--tarballs <dir>]');
  process.exit(2);
}
const tarballFile = (name: string, version: string) =>
  `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;

const tmp = mkdtempSync(join(tmpdir(), 'knead-pack-'));
const tarballs = new Map<string, string>();

try {
  for (const dir of readdirSync(join(root, 'packages'))) {
    const pkgDir = join(root, 'packages', dir);
    const manifest = join(pkgDir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.private) continue;
    const label = pkg.name as string;
    try {
      const expected = tarballFile(label, pkg.version);
      if (tarballDir === undefined) run(['pnpm', 'pack', '--pack-destination', tmp], pkgDir);
      const from = tarballDir ?? tmp;
      const tarball = join(from, expected);
      if (!existsSync(tarball)) throw new Error(`tarball ${expected} not found`);
      tarballs.set(label, tarball);
      const listing = listTarball(tarball);
      const entries = listing.map((e) => e.name.replace(/^package\//, ''));
      for (const e of entries) {
        if (forbidden.some((re) => re.test(`/${e}`)))
          problems.push(`${label}: forbidden entry ${e}`);
      }
      const targets = exportTargets(pkg.publishConfig?.exports ?? pkg.exports);
      if (targets.length === 0) problems.push(`${label}: package.json declares no exports`);
      for (const r of [...required, ...targets]) {
        if (!entries.includes(r)) problems.push(`${label}: missing ${r}`);
      }
      const packed = run(['tar', 'xzf', tarball, '-O', 'package/package.json'], tmp).stdout;
      if (packed.includes('workspace:'))
        problems.push(`${label}: packed package.json contains workspace:`);
      const packedManifest = JSON.parse(packed);
      if (JSON.stringify(packedManifest.exports).includes('/src/'))
        problems.push(`${label}: exports point at src`);
      for (const p of publishProblems(packedManifest, listing, publishRules))
        problems.push(`${label}: ${p} (the release's publish step would refuse it)`);
      console.log(`${label}: ${entries.length} entries ok`);
    } catch (err) {
      problems.push(`${label}: ${(err as Error).message}`);
    }
    if (tarballDir === undefined) {
      // prepack copies the root licenses in; don't leave them in the working tree.
      for (const f of ['LICENSE-MIT', 'LICENSE-APACHE']) rmSync(join(pkgDir, f), { force: true });
    }
  }
  if (tarballDir !== undefined) {
    // Every tarball there is the one about to be published, so none may go unchecked.
    const checked = new Set([...tarballs.values()].map((t) => basename(t)));
    for (const f of readdirSync(tarballDir)) {
      if (f.endsWith('.tgz') && !checked.has(f)) problems.push(`unexpected tarball ${f}`);
    }
  }
  if (problems.length === 0) {
    try {
      smokeTest(join(tmp, 'consumer'), [...tarballs.keys()], consumerApp());
      console.log('consumer smoke test ok');
    } catch (err) {
      problems.push(`consumer smoke test: ${(err as Error).message}`);
    }
    // @knead-js/graphql is an optional peer of @knead-js/casl: an app without it (or graphql)
    // installed must typecheck and run.
    try {
      smokeTest(
        join(tmp, 'consumer-casl'),
        ['@knead-js/core', '@knead-js/http', '@knead-js/casl'],
        caslOnlyApp(),
      );
      console.log('casl-only consumer smoke test ok');
    } catch (err) {
      problems.push(`casl-only consumer smoke test: ${(err as Error).message}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`\npack check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('pack check passed');

/**
 * Installs the named packed tarballs (and the third-party dependencies they need) into a fresh
 * project, typechecks `source` strictly and runs it; it must print "consumer ok".
 */
function smokeTest(dir: string, names: string[], source: string): void {
  const modules = join(dir, 'node_modules');
  const needed = new Set<string>(['@types/bun']);
  for (const name of names) {
    const tarball = tarballs.get(name);
    if (!tarball) throw new Error(`${name} was not packed`);
    const target = join(modules, name);
    mkdirSync(target, { recursive: true });
    run(['tar', 'xzf', tarball, '-C', target, '--strip-components=1'], dir);
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    const optional = manifest.peerDependenciesMeta ?? {};
    for (const dep of Object.keys(manifest.dependencies ?? {})) needed.add(dep);
    for (const dep of Object.keys(manifest.peerDependencies ?? {})) {
      if (optional[dep]?.optional !== true) needed.add(dep);
    }
  }
  // Third-party dependencies come from the workspace install (their realpaths, so their own
  // dependencies resolve inside the pnpm store).
  const thirdParty: [string, string][] = [
    ['@standard-schema/spec', 'packages/http/node_modules/@standard-schema/spec'],
    ['sanitize-html', 'packages/sanitize/node_modules/sanitize-html'],
    ['graphql', 'packages/graphql/node_modules/graphql'],
    ['dataloader', 'packages/graphql/node_modules/dataloader'],
    ['@leaven-graphql/core', 'packages/graphql/node_modules/@leaven-graphql/core'],
    ['@leaven-graphql/errors', 'packages/graphql/node_modules/@leaven-graphql/errors'],
    ['@leaven-graphql/playground', 'packages/graphql/node_modules/@leaven-graphql/playground'],
    ['@leaven-graphql/ws', 'packages/graphql/node_modules/@leaven-graphql/ws'],
    ['@casl/ability', 'packages/casl/node_modules/@casl/ability'],
    ['croner', 'packages/schedule/node_modules/croner'],
    ['@types/bun', 'node_modules/@types/bun'],
  ];
  for (const dep of needed) {
    if (dep.startsWith('@knead-js/') && !names.includes(dep)) {
      throw new Error(
        `${dep} is a required dependency or peer of a package in this smoke test but is not ` +
          `among its packed packages (${names.join(', ')})`,
      );
    }
  }
  const known = new Set(thirdParty.map(([name]) => name));
  for (const dep of needed) {
    if (!dep.startsWith('@knead-js/') && !known.has(dep)) {
      throw new Error(`${dep} is needed but not in check-pack's thirdParty list`);
    }
  }
  for (const [name, from] of thirdParty) {
    if (!needed.has(name)) continue;
    const link = join(modules, name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(join(root, from)), link, 'dir');
  }
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'knead-consumer', private: true, type: 'module' }),
  );
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ESNext', 'ESNext.Decorators'],
        types: ['bun'],
        strict: true,
        noEmit: true,
        verbatimModuleSyntax: true,
        skipLibCheck: false,
      },
      include: ['app.ts'],
    }),
  );
  writeFileSync(join(dir, 'app.ts'), source);
  run([join(root, 'node_modules/.bin/tsc'), '--noEmit', '-p', join(dir, 'tsconfig.json')], dir);
  const { stdout, stderr } = run(['bun', join(dir, 'app.ts')], dir);
  if (!stdout.includes('consumer ok')) throw new Error(`unexpected output: ${stdout}${stderr}`);
  if (stderr.includes('Multiple copies')) throw new Error(`duplicate framework copies: ${stderr}`);
}

function consumerApp(): string {
  return `
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import { AbilityGuard, Can, CaslModule, definePermissions } from '@knead-js/casl';
import { ConfigModule, defineConfig } from '@knead-js/config';
import { Injectable, inject, Module } from '@knead-js/core';
import { CorsModule } from '@knead-js/cors';
import { Field, GraphQLModule, ID, ObjectType, Query, Resolver, type ResolverCtx } from '@knead-js/graphql';
import { Controller, type Ctx, Get, KneadFactory, UseGuards } from '@knead-js/http';
import { JsonLogger, LoggingModule } from '@knead-js/logging';
import { PrismaModule } from '@knead-js/prisma';
import { toHttpException } from '@knead-js/prisma/http';
import { withRollback } from '@knead-js/prisma/testing';
import { RateLimitModule } from '@knead-js/rate-limit';
import { sanitize, type SanitizePolicy } from '@knead-js/sanitize';
import { Interval, ScheduleModule, SchedulerRegistry } from '@knead-js/schedule';
import { SecurityHeadersModule } from '@knead-js/security-headers';
import { Test } from '@knead-js/testing';

// A hand-written Standard Schema with Standard JSON Schema, so the consumer needs no validator.
interface Settings {
  greeting: string;
}
const settingsSchema: StandardSchemaV1<Settings> & StandardJSONSchemaV1<Settings> = {
  '~standard': {
    version: 1,
    vendor: 'knead-consumer',
    validate: (value) => {
      const greeting = (value as Partial<Settings> | undefined)?.greeting;
      return typeof greeting === 'string'
        ? { value: { greeting } }
        : { issues: [{ message: 'Missing value', path: ['greeting'] }] };
    },
    jsonSchema: {
      input: () => ({ type: 'object', properties: { greeting: { type: 'string' } } }),
      output: () => ({ type: 'object', properties: { greeting: { type: 'string' } } }),
    },
  },
};
const AppConfig = defineConfig(settingsSchema, { name: 'AppConfig' });

@Injectable()
class Greeter {
  greet(name: string): string {
    return sanitize(\`<b>hello \${name}</b><script>x</script>\`, 'basic');
  }
}

@Controller('/greet')
class GreetController {
  readonly greeter = inject(Greeter);

  @Get('/:name')
  greet({ params }: Ctx<{ params: { name: string } }>) {
    return { message: this.greeter.greet(params.name) };
  }
}

const permissions = definePermissions({
  greetings: {
    levels: ['none', 'read'],
    rules: { read: [{ action: 'read', subject: 'Greeting' }] },
  },
});

@Controller('/secret')
@UseGuards(AbilityGuard)
class SecretController {
  @Get('/') @Can('read', 'Greeting') secret() {
    return { secret: true };
  }
}

@ObjectType()
class Greeting {
  @Field(() => ID) id!: string;
  @Field(() => String) text!: string;
}

const fakePrisma = {
  async $connect() {},
  async $disconnect() {},
  async $transaction<R>(fn: (tx: object) => Promise<R>): Promise<R> {
    return fn({});
  },
};

@Injectable()
class Ticker {
  ticks = 0;

  @Interval(10)
  tick() {
    this.ticks++;
  }
}

@Resolver()
class GreetingResolver {
  readonly greeter = inject(Greeter);

  @Query(() => Greeting, { args: { name: String } })
  greeting(ctx: ResolverCtx<{ name: string }>): Greeting {
    return { id: '1', text: this.greeter.greet(ctx.args.name) };
  }
}

const logLines: string[] = [];

@Module({
  imports: [
    LoggingModule.forRoot({ write: (line) => logLines.push(line) }),
    GraphQLModule.forRoot(),
    CorsModule.forRoot({ origin: 'https://app.example' }),
    RateLimitModule.forRoot({ limit: 10, window: '1m' }),
    SecurityHeadersModule.forRoot(),
    CaslModule.forRoot({
      permissions,
      resolve: ({ req }: Ctx) => {
        const grant = req.headers.get('x-grant');
        return grant === null ? undefined : { user: {}, grant };
      },
      defineUserAbility: (_user, { can }) => {
        can('read', 'Greeting');
      },
    }),
    ScheduleModule.forRoot(),
    PrismaModule.forRoot({ instance: fakePrisma }),
    ConfigModule.forRoot(AppConfig, { loaders: [() => ({ GREETING: 'hello from config' })] }),
  ],
  controllers: [GreetController, SecretController],
  providers: [Greeter, GreetingResolver, Ticker],
})
class AppModule {}

const policy: SanitizePolicy = { allowedTags: ['b'], allowedAttributes: {} };

// @knead-js/testing compiles a module, and @knead-js/prisma/testing rolls back through it.
const testing = await Test.createModule({
  imports: [PrismaModule.forRoot({ instance: fakePrisma })],
  providers: [Greeter],
}).compile();
let rolledBack: number | undefined;
let testingGreeting: string | undefined;
try {
  rolledBack = await withRollback(testing, async () => 42);
  testingGreeting = testing.get(Greeter).greet('ada');
} finally {
  await testing.close();
}

const app = await KneadFactory.create(AppModule);
await app.listen({ port: 0, hostname: '127.0.0.1' });
try {
  const res = await fetch(new URL('/greet/ada', app.url), {
    headers: { origin: 'https://app.example' },
  });
  const body = (await res.json()) as { message: string };
  const gql = await fetch(new URL('/graphql', app.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.example' },
    body: JSON.stringify({ query: '{ greeting(name: "ada") { text } }' }),
  });
  const gqlBody = (await gql.json()) as { data?: { greeting: { text: string } } };
  await Bun.sleep(50);
  const secret = (grant?: string) =>
    fetch(new URL('/secret', app.url), { headers: grant === undefined ? {} : { 'x-grant': grant } });
  const checks = [
    res.status === 200,
    body.message === sanitize('<b>hello ada</b>', policy),
    res.headers.get('access-control-allow-origin') === 'https://app.example',
    res.headers.get('ratelimit-limit') === '10',
    res.headers.get('x-frame-options') === 'DENY',
    gql.status === 200,
    gqlBody.data?.greeting.text === body.message,
    (await secret('greetings:read')).status === 200,
    (await secret('')).status === 403,
    (await secret()).status === 401,
    app.get(Ticker).ticks > 0,
    app.get(SchedulerRegistry).get('Ticker.tick')?.state === 'scheduled',
    toHttpException(new Error('not prisma')) === undefined,
    toHttpException({ name: 'PrismaClientValidationError' })?.status === 400,
    app.logger instanceof JsonLogger,
    logLines.some((line) => (JSON.parse(line) as { msg: string }).msg.startsWith('Listening')),
    app.get(AppConfig).get('greeting') === 'hello from config',
    JSON.stringify(app.get(AppConfig)) === '{"greeting":"[redacted]"}',
    rolledBack === 42,
    testingGreeting === body.message,
  ];
  if (checks.includes(false)) throw new Error(\`checks failed: \${JSON.stringify(checks)}\`);
} finally {
  await app.close();
}
console.log('consumer ok');
`;
}

/** Uses @knead-js/casl without @knead-js/graphql (an optional peer) or graphql installed. */
function caslOnlyApp(): string {
  return `
import {
  AbilityGuard,
  AbilityService,
  Can,
  CaslModule,
  definePermissions,
  fullGrant,
  PermittedFields,
} from '@knead-js/casl';
import { inject, Module } from '@knead-js/core';
import { Controller, type Ctx, Get, KneadFactory, MemoryLogger, UseGuards } from '@knead-js/http';

const permissions = definePermissions({
  posts: {
    levels: ['none', 'read'],
    rules: { read: [{ action: 'read', subject: 'Post', fields: ['id', 'title'] }] },
  },
});

interface User {
  id: string;
}

@Controller('/posts')
@UseGuards(AbilityGuard)
class PostsController {
  readonly abilities = inject(AbilityService);

  @Get('/') @Can('read', 'Post') @PermittedFields('Post') list() {
    return [{ id: '1', title: 'hello', draft: 'secret' }];
  }
}

@Module({
  imports: [
    CaslModule.forRoot<User>({
      permissions,
      resolve: ({ req }: Ctx) => {
        const id = req.headers.get('x-user');
        return id === null ? undefined : { user: { id }, grant: fullGrant(permissions) };
      },
      defineUserAbility: (_user, { can }) => {
        can('read', 'Post');
      },
    }),
  ],
  controllers: [PostsController],
})
class AppModule {}

const app = await KneadFactory.create(AppModule, { logger: new MemoryLogger() });
await app.listen({ port: 0, hostname: '127.0.0.1' });
try {
  const ok = await fetch(new URL('/posts', app.url), { headers: { 'x-user': 'ada' } });
  const posts = (await ok.json()) as Record<string, unknown>[];
  const anonymous = await fetch(new URL('/posts', app.url));
  const checks = [
    ok.status === 200,
    JSON.stringify(posts) === JSON.stringify([{ id: '1', title: 'hello' }]),
    anonymous.status === 401,
  ];
  if (checks.includes(false)) throw new Error(\`checks failed: \${JSON.stringify(checks)}\`);
} finally {
  await app.close();
}
console.log('consumer ok');
`;
}
