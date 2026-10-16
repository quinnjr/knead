import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InjectionToken, inject, Module } from '@hpmws/core';
import { APP_GUARD, type Ctx, HttpConfigError } from '@hpmws/http';
import { RateLimitModule } from '@hpmws/rate-limit';
import { SecurityHeadersModule } from '@hpmws/security-headers';
import { Test } from '@hpmws/testing';
import {
  GraphQLModule,
  GraphQLRuntime,
  Int,
  PUBSUB,
  PubSub,
  playgroundPage,
  printSortedSchema,
  Query,
  Resolver,
  resolveOptions,
} from '../src/index.js';
import { BlogModule } from './fixtures/blog.js';
import { type Started, startGraphQL } from './helpers.js';

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

describe('defaults follow the application development flag', () => {
  test('development: false wins over NODE_ENV=development', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const mod = await Test.createModule({
        imports: [GraphQLModule.forRoot({ emitSchemaFile: false }), DevFlagModule],
      }).compile({ development: false });
      try {
        const o = mod.get(GraphQLRuntime).options;
        expect(o).toMatchObject({ playground: false, introspection: false, maskErrors: true });
      } finally {
        await mod.close();
      }
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  test('development: true enables the tooling without NODE_ENV', async () => {
    const mod = await Test.createModule({
      imports: [GraphQLModule.forRoot({ emitSchemaFile: false }), DevFlagModule],
    }).compile({ development: true });
    try {
      const o = mod.get(GraphQLRuntime).options;
      expect(o).toMatchObject({ playground: true, introspection: true, maskErrors: false });
    } finally {
      await mod.close();
    }
  });

  test('resolveOptions accepts the boolean flag', () => {
    expect(resolveOptions({}, '/g', true).maskErrors).toBe(false);
    expect(resolveOptions({}, '/g', false).maskErrors).toBe(true);
  });
});

describe('resolveOptions defaults', () => {
  test('development enables tooling and disables masking', () => {
    const o = resolveOptions({}, '/graphql', 'development');
    expect(o).toMatchObject({
      playground: true,
      introspection: true,
      maskErrors: false,
      emitSchemaFile: 'schema.graphql',
      csrf: { requiredHeaders: ['x-graphql-request'] },
    });
  });

  test('anything else is production: no playground or introspection, masked errors', () => {
    for (const env of ['production', 'test', undefined]) {
      expect(resolveOptions({}, '/graphql', env)).toMatchObject({
        playground: false,
        introspection: false,
        maskErrors: true,
        emitSchemaFile: false,
      });
    }
  });

  test('an explicit playground turns introspection on unless set', () => {
    expect(resolveOptions({ playground: true }, '/g', 'production').introspection).toBe(true);
    expect(
      resolveOptions({ playground: true, introspection: false }, '/g', 'production').introspection,
    ).toBe(false);
  });

  test('csrf header names are lower-cased; an empty list is a config error', () => {
    expect(resolveOptions({ csrf: { requiredHeaders: ['X-Requested-With'] } }, '/g').csrf).toEqual({
      requiredHeaders: ['x-requested-with'],
    });
    expect(() => GraphQLModule.forRoot({ csrf: { requiredHeaders: [] } })).toThrow(HttpConfigError);
    expect(() => GraphQLModule.forRoot({ path: '/g/:id' })).toThrow('GraphQL path must be exact');
  });
});

describe('GraphQLModule', () => {
  test('custom path; csrf: false allows plain GET', async () => {
    s = await startGraphQL([BlogModule], { path: 'api/gql/', csrf: false });
    const res = await s.app.request('GET', '/api/gql', {
      query: { query: '{ post(id: "p1") { title } }' },
    });
    expect(await res.json()).toEqual({ data: { post: { title: 'Hello' } } });
  });

  test('forRootAsync resolves options through DI', async () => {
    const FLAG = new InjectionToken<boolean>('FLAG');
    @Module({ providers: [{ provide: FLAG, useValue: false }], exports: [FLAG] })
    class ConfigModule {}
    const mod = await Test.createModule({
      imports: [
        GraphQLModule.forRootAsync({
          path: '/async',
          imports: [ConfigModule],
          useFactory: async () => ({ csrf: inject(FLAG) ? undefined : false }),
        }),
        BlogModule,
      ],
    }).compile({ development: false });
    const app = await mod.createApp();
    try {
      const res = await app.request('GET', '/async', {
        query: { query: '{ post(id: "p2") { title } }' },
      });
      expect(await res.json()).toEqual({ data: { post: { title: 'Again' } } });
    } finally {
      await mod.close();
    }
  });

  test('PUBSUB defaults to an in-memory PubSub; a custom engine is used when given', async () => {
    s = await startGraphQL([BlogModule]);
    expect(s.mod.get(PUBSUB)).toBeInstanceOf(PubSub);
    await s.mod.close();
    const custom = {
      subscribe: () => () => {},
      publish: () => {},
      closed: false,
      close() {
        this.closed = true;
      },
    };
    s = await startGraphQL([BlogModule], { pubsub: custom });
    expect(s.mod.get(PUBSUB)).toBe(custom);
    await s.mod.close();
    s = undefined;
    expect(custom.closed).toBe(true);
  });

  test('emitSchemaFile writes the sorted SDL', async () => {
    const file = join(tmpdir(), `hpmws-gql-${crypto.randomUUID()}.graphql`);
    try {
      s = await startGraphQL([BlogModule], { emitSchemaFile: file });
      const written = await Bun.file(file).text();
      expect(written).toBe(printSortedSchema(s.mod.get(GraphQLRuntime).schema));
      expect(written.startsWith('input CreatePostInput')).toBe(true);
    } finally {
      rmSync(file, { force: true });
    }
  });

  test('maxComplexity uses per-field complexity', async () => {
    @Resolver()
    class R {
      @Query(() => Int, { complexity: 50 }) heavy() {
        return 1;
      }
      @Query(() => Int) light() {
        return 1;
      }
    }
    @Module({ providers: [R] })
    class M {}
    s = await startGraphQL([M], { maxComplexity: 10 });
    expect((await s.app.graphql('{ light }')).data).toEqual({ light: 1 });
    const heavy = await s.app.graphql('{ heavy }');
    expect(heavy.errors?.[0]?.extensions?.code).toBe('COMPLEXITY_LIMIT');
  });

  test('user compilerOptions keep the per-field complexity calculator', async () => {
    @Resolver()
    class R {
      @Query(() => Int, { complexity: 50 }) heavy() {
        return 1;
      }
    }
    @Module({ providers: [R] })
    class M {}
    s = await startGraphQL([M], {
      maxComplexity: 10,
      compilerOptions: { calculateComplexity: true },
    });
    const heavy = await s.app.graphql('{ heavy }');
    expect(heavy.errors?.[0]?.extensions?.code).toBe('COMPLEXITY_LIMIT');
  });
});

describe('playground and CSP', () => {
  test('served for Accept: text/html with a CSP hashing its inline script', async () => {
    s = await startGraphQL([BlogModule, SecurityHeadersModule.forRoot()], { playground: true });
    const res = await s.app.request('GET', '/graphql', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    const csp = res.headers.get('content-security-policy')!;
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const hash = new Bun.CryptoHasher('sha256').update(script).digest('base64');
    expect(csp).toContain(`'sha256-${hash}'`);
    expect(csp).toContain(
      'https://cdn.jsdelivr.net/npm/graphql-playground-react@1.7.28/build/static/js/middleware.js',
    );
    expect(csp).not.toMatch(/script-src[^;]*https:\/\/cdn\.jsdelivr\.net[ ;]/);
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  test('JSON responses keep the strict default CSP', async () => {
    s = await startGraphQL([BlogModule, SecurityHeadersModule.forRoot()], { playground: true });
    const res = await s.app.graphql('{ post(id: "p1") { title } }');
    expect(res.headers.get('content-security-policy')).not.toContain('cdn.jsdelivr.net');
  });

  test('playgroundPage embeds the subscription endpoint', () => {
    const page = playgroundPage('/graphql', 'ws://localhost/graphql');
    expect(page.html).toContain('"ws://localhost/graphql"');
  });
});

describe('global middleware and guards', () => {
  test('APP_GUARD guards run on the GraphQL HTTP route', async () => {
    s = await startGraphQL([BlogModule], {}, [
      { provide: APP_GUARD, multi: true, useValue: (ctx: Ctx) => ctx.req.headers.has('x-ok') },
    ]);
    expect((await s.app.graphql('{ post(id: "p1") { title } }')).status).toBe(403);
    const ok = await s.app.graphql('{ post(id: "p1") { title } }', { headers: { 'x-ok': '1' } });
    expect(ok.data).toEqual({ post: { title: 'Hello' } });
  });

  test('rate limiting applies to the GraphQL route', async () => {
    s = await startGraphQL([BlogModule, RateLimitModule.forRoot({ limit: 1, window: '1m' })]);
    expect((await s.app.graphql('{ post(id: "p1") { title } }')).status).toBe(200);
    expect((await s.app.graphql('{ post(id: "p1") { title } }')).status).toBe(429);
  });
});

@Resolver()
class DevFlagResolver {
  @Query(() => Int) one() {
    return 1;
  }
}

@Module({ providers: [DevFlagResolver] })
class DevFlagModule {}
