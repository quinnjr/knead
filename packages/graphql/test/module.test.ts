import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InjectionToken, inject, Module } from '@knead-js/core';
import { APP_GUARD, type Ctx, HttpConfigError } from '@knead-js/http';
import { RateLimitModule } from '@knead-js/rate-limit';
import { SecurityHeadersModule } from '@knead-js/security-headers';
import { Test } from '@knead-js/testing';
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

describe('options validated at bootstrap', () => {
  test('cacheControl must be a valid header value', () => {
    for (const cacheControl of [
      'no-store\r\nset-cookie: a=b',
      'a\nb',
      'no-store\n',
      'x\u0000',
      3 as never,
    ]) {
      expect(() => GraphQLModule.forRoot({ cacheControl })).toThrow(HttpConfigError);
    }
    expect(resolveOptions({ cacheControl: 'private, max-age=60' }, '/g').cacheControl).toBe(
      'private, max-age=60',
    );
    expect(resolveOptions({ cacheControl: false }, '/g').cacheControl).toBe(false);
  });

  test('csrf.requiredHeaders entries must be header names', () => {
    for (const name of ['', 'x y', 'x:y', 'x\r\ny', 'é', 7 as never]) {
      expect(() => GraphQLModule.forRoot({ csrf: { requiredHeaders: [name] } })).toThrow(
        HttpConfigError,
      );
    }
    expect(() =>
      GraphQLModule.forRoot({ csrf: { requiredHeaders: ['X-Requested-With', 'x-csrf_token'] } }),
    ).not.toThrow();
  });

  test('subscription timing and count options must be integers in range', () => {
    const bad = [0, -1, 1.5, Number.NaN, Infinity, '10' as never];
    for (const value of bad) {
      expect(() =>
        GraphQLModule.forRoot({ subscriptions: { connectionInitTimeout: value } }),
      ).toThrow(HttpConfigError);
      expect(() =>
        GraphQLModule.forRoot({ subscriptions: { maxSubscriptionsPerConnection: value } }),
      ).toThrow(HttpConfigError);
      expect(() =>
        GraphQLModule.forRoot({ subscriptions: { maxConnectionLifetime: value } }),
      ).toThrow(HttpConfigError);
      if (value !== 0) {
        expect(() =>
          GraphQLModule.forRoot({ subscriptions: { keepAliveInterval: value } }),
        ).toThrow(HttpConfigError);
      }
    }
    // keepAliveInterval 0 disables the pings.
    expect(() =>
      GraphQLModule.forRoot({
        subscriptions: {
          connectionInitTimeout: 1000,
          keepAliveInterval: 0,
          maxSubscriptionsPerConnection: 5,
        },
      }),
    ).not.toThrow();
    // A timer delay above 2^31 - 1 ms overflows to 1 ms in setTimeout/setInterval.
    expect(() =>
      GraphQLModule.forRoot({ subscriptions: { connectionInitTimeout: 2 ** 31 } }),
    ).toThrow(HttpConfigError);
    expect(() => GraphQLModule.forRoot({ subscriptions: { keepAliveInterval: 2 ** 31 } })).toThrow(
      HttpConfigError,
    );
    expect(() =>
      GraphQLModule.forRoot({ subscriptions: { maxConnectionLifetime: 2 ** 31 } }),
    ).toThrow(HttpConfigError);
    expect(() =>
      GraphQLModule.forRoot({ subscriptions: { maxConnectionLifetime: 2 ** 31 - 1 } }),
    ).not.toThrow();
  });

  test('sse defaults on with no explicit keep-alive (each stream derives one)', () => {
    expect(resolveOptions({}, '/graphql').sse).toEqual({ keepAliveInterval: undefined });
    expect(resolveOptions({ subscriptions: { sse: {} } }, '/graphql').sse).toEqual({
      keepAliveInterval: undefined,
    });
    expect(
      resolveOptions({ subscriptions: { sse: { keepAliveInterval: 500 } } }, '/graphql').sse,
    ).toEqual({ keepAliveInterval: 500 });
  });

  test('subscriptions.sse other than false or an object is an HttpConfigError', () => {
    for (const sse of [true, 'on', null, 1]) {
      expect(() => GraphQLModule.forRoot({ subscriptions: { sse: sse as never } })).toThrow(
        HttpConfigError,
      );
      expect(() => GraphQLModule.forRoot({ subscriptions: { sse: sse as never } })).toThrow(
        'GraphQL subscriptions.sse must be false or an object',
      );
    }
  });

  test('subscriptions: false turns sse off', () => {
    expect(resolveOptions({ subscriptions: false }, '/graphql').sse).toBe(false);
  });

  test('subscriptions.sse: false turns only sse off', () => {
    const o = resolveOptions({ subscriptions: { sse: false } }, '/graphql');
    expect(o.sse).toBe(false);
    expect(typeof o.subscriptions).toBe('object');
  });

  test('sse.keepAliveInterval must be an integer from 1 to 2 ** 31 - 1', () => {
    for (const value of [0, -1, 1.5, '8000' as never, 2 ** 31, Number.NaN]) {
      expect(() =>
        GraphQLModule.forRoot({ subscriptions: { sse: { keepAliveInterval: value } } }),
      ).toThrow(HttpConfigError);
    }
    expect(() =>
      GraphQLModule.forRoot({ subscriptions: { sse: { keepAliveInterval: 2 ** 31 - 1 } } }),
    ).not.toThrow();
    expect(() => GraphQLModule.forRoot({ subscriptions: { sse: false } })).not.toThrow();
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
    const file = join(tmpdir(), `knead-gql-${crypto.randomUUID()}.graphql`);
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
    // No third-party font hosts: Google Fonts is blocked and the page uses system fonts.
    expect(csp).not.toContain('fonts.googleapis.com');
    expect(csp).not.toContain('fonts.gstatic.com');
    expect(csp).toContain("font-src 'self' data:;");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    // The page still renders: the playground bundle and stylesheet load with their SRI hashes.
    expect(html).toContain('GraphQLPlayground.init');
    expect(html).toMatch(/<script src="[^"]+middleware\.js" integrity="sha384-[^"]+"/);
    expect(html).toMatch(/<link\s+rel="stylesheet"\s+href="[^"]+index\.css" integrity="sha384-/);
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
