import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import { HttpConfigError } from '@hpmws/http';
import { getIntrospectionQuery } from 'graphql';
import {
  Field,
  Int,
  ObjectType,
  Query,
  Resolver,
  resolveOptions,
  Subscription,
} from '../src/index.js';
import { GraphQLRuntime } from '../src/runtime.js';
import { type Started, startGraphQL } from './helpers.js';

@ObjectType()
class Tree {
  @Field(() => Int) n!: number;
  @Field(() => Tree) child!: Tree;
}

const tree: Tree = {
  n: 1,
  get child() {
    return tree;
  },
};

@Resolver()
class R {
  @Query(() => Tree) tree() {
    return tree;
  }
  @Query(() => Int, { complexity: 2000 }) expensive() {
    return 1;
  }
  @Subscription(() => Int, { topic: 't' }) t() {}
}

@Module({ providers: [R] })
class M {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

/** `{ tree { child { child ... { n } } } }` with `depth` levels of fields. */
const deep = (depth: number) =>
  `{ tree ${'{ child '.repeat(depth - 2)}{ n }${' }'.repeat(depth - 2)} }`;
const aliases = (count: number) =>
  `{ ${Array.from({ length: count }, (_, i) => `a${i}: tree { n }`).join(' ')} }`;

describe('safe default limits', () => {
  test('resolveOptions applies the defaults', () => {
    const o = resolveOptions({}, '/graphql');
    // hpmws checks depth itself (introspection excluded), so Leaven gets no maxDepth.
    expect(o.maxDepth).toBe(10);
    expect(o.executor.maxDepth).toBeUndefined();
    expect(o.executor.maxComplexity).toBe(1000);
    expect(o.executor.parseOptions?.maxTokens).toBe(3000);
    expect(o.maxFields).toBe(1000);
    expect(o.executor.cache).toEqual({ maxSize: 100 });
    expect(o.maxQueryLength).toBe(100 * 1024);
    expect(o.maxAliases).toBe(30);
  });

  test('Infinity or false opts out; other parseOptions are kept', () => {
    const o = resolveOptions(
      {
        maxDepth: Infinity,
        maxComplexity: false,
        maxQueryLength: false,
        maxAliases: Infinity,
        parseOptions: { maxTokens: Infinity, graphqlOptions: { noLocation: true } },
      },
      '/graphql',
    );
    expect(o.maxDepth).toBe(false);
    expect(o.executor.maxComplexity).toBeUndefined();
    expect(o.executor.parseOptions).toEqual({ graphqlOptions: { noLocation: true } });
    expect(o.maxQueryLength).toBe(false);
    expect(o.maxAliases).toBe(false);
  });

  test('invalid limits are configuration errors', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveOptions({ maxDepth: bad }, '/graphql')).toThrow(HttpConfigError);
      expect(() => resolveOptions({ maxAliases: bad }, '/graphql')).toThrow(HttpConfigError);
    }
  });

  test('maxDepth 10: depth 10 runs, depth 11 is DEPTH_LIMIT', async () => {
    s = await startGraphQL([M]);
    expect((await s.app.graphql(deep(10))).errors).toBeUndefined();
    const res = await s.app.graphql(deep(11));
    expect(res.data).toBeUndefined();
    expect(res.errors?.[0]?.extensions?.code).toBe('DEPTH_LIMIT');
  });

  test('the full introspection query passes with the default maxDepth', async () => {
    s = await startGraphQL([M], { introspection: true });
    const res = await s.app.graphql(getIntrospectionQuery());
    expect(res.errors).toBeUndefined();
    expect(res.data?.__schema).toBeDefined();
  });

  test('the depth error keeps its code and message shape', async () => {
    s = await startGraphQL([M]);
    const res = await s.app.graphql(deep(12));
    expect(res.errors?.[0]).toMatchObject({
      message: 'Query depth of 12 exceeds maximum allowed depth of 10',
      extensions: { code: 'DEPTH_LIMIT' },
    });
  });

  test('a depth bomb inside a fragment is rejected', async () => {
    s = await startGraphQL([M]);
    const res = await s.app.graphql(
      `{ tree { ...F } } fragment F on Tree { ${'child { '.repeat(10)}n${' }'.repeat(10)} }`,
    );
    expect(res.errors?.[0]?.extensions?.code).toBe('DEPTH_LIMIT');
  });

  test('ordinary fields deeper than maxDepth next to __type are rejected', async () => {
    s = await startGraphQL([M], { introspection: true });
    const res = await s.app.graphql(`{ __type(name: "Tree") { name } ${deep(11).slice(1, -1)} }`);
    expect(res.errors?.[0]?.extensions?.code).toBe('DEPTH_LIMIT');
  });

  test('a cyclic fragment query is rejected without hanging', async () => {
    s = await startGraphQL([M]);
    const started = performance.now();
    const res = await s.app.graphql(
      '{ tree { ...A } } fragment A on Tree { child { ...B } } fragment B on Tree { child { ...A } }',
    );
    expect(res.data).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('maxComplexity 1000', async () => {
    s = await startGraphQL([M]);
    const res = await s.app.graphql('{ expensive }');
    expect(res.errors?.[0]?.extensions?.code).toBe('COMPLEXITY_LIMIT');
  });

  test('maxTokens 3000', async () => {
    s = await startGraphQL([M]);
    const res = await s.app.graphql(`{ tree { ${'n '.repeat(3001)}} }`);
    expect(res.data).toBeUndefined();
    expect(res.errors?.[0]?.message).toContain('tokens');
  });

  test('maxAliases 30 per document', async () => {
    s = await startGraphQL([M]);
    expect((await s.app.graphql(aliases(30))).errors).toBeUndefined();
    const res = await s.app.graphql(aliases(31));
    expect(res.data).toBeUndefined();
    expect(res.errors?.[0]).toMatchObject({
      message: 'The document has 31 aliases; at most 30 are allowed.',
      extensions: { code: 'BAD_USER_INPUT' },
    });
    await s.mod.close();
    s = await startGraphQL([M], { maxAliases: false });
    expect((await s.app.graphql(aliases(31))).errors).toBeUndefined();
  });

  test('maxQueryLength over POST and GET (400)', async () => {
    s = await startGraphQL([M], { maxQueryLength: 100 });
    const long = `{ tree { n } }${' '.repeat(100)}`;
    expect((await s.app.graphql(long)).status).toBe(400);
    const get = await s.app.request('GET', '/graphql', {
      headers: { 'x-graphql-request': '1' },
      query: { query: long },
    });
    expect(get.status).toBe(400);
    expect((await s.app.graphql('{ tree { n } }')).status).toBe(200);
  });

  test('the default maxQueryLength is 100 KiB', async () => {
    s = await startGraphQL([M]);
    const res = await s.app.graphql(`{ tree { n } }${' '.repeat(100 * 1024)}`);
    expect(res.status).toBe(400);
  });

  test('with the defaults, an over-long WebSocket query gets the error (the payload fits)', async () => {
    s = await startGraphQL([M]);
    const sub = await s.app.graphqlSubscribe(`subscription { t }${' '.repeat(100 * 1024)}`);
    const first = await sub.next();
    expect(first.value?.errors?.[0]?.message).toBe('The query is longer than 102400 characters.');
    await sub.close();
  });

  test('maxQueryLength over WebSocket: an error for that id, nothing executes', async () => {
    s = await startGraphQL([M], { maxQueryLength: 100 });
    const sub = await s.app.graphqlSubscribe(`subscription { t }${' '.repeat(100)}`);
    const first = await sub.next();
    expect(first.value?.errors?.[0]).toMatchObject({
      message: 'The query is longer than 100 characters.',
      extensions: { code: 'BAD_USER_INPUT' },
    });
    expect((await sub.next()).done).toBe(true);
    await sub.close();
  });
});

describe('maxFields (FIELD_LIMIT)', () => {
  const cacheSize = async () =>
    (await s!.mod.get(GraphQLRuntime).executor.getCacheStats()).document?.size ?? 0;

  test('getIntrospectionQuery() passes every default', async () => {
    s = await startGraphQL([M], { introspection: true });
    const res = await s.app.graphql(getIntrospectionQuery());
    expect(res.errors).toBeUndefined();
  });

  test('1000 fields run, 1001 are FIELD_LIMIT; fragments count where spread', async () => {
    s = await startGraphQL([M], { maxComplexity: false });
    expect((await s.app.graphql(`{ tree { ${'n '.repeat(999)}} }`)).errors).toBeUndefined();
    const res = await s.app.graphql(`{ tree { ${'n '.repeat(1000)}} }`);
    expect(res.errors?.[0]?.extensions?.code).toBe('FIELD_LIMIT');
    // 4 fields in F, spread 300 times: 1200 fields from a short document.
    const spread = await s.app.graphql(
      `{ tree { ${'...F '.repeat(300)}} } fragment F on Tree { n child { n child { n } } }`,
    );
    expect(spread.errors?.[0]?.extensions?.code).toBe('FIELD_LIMIT');
  });

  test('fields in a fragment that is never spread count too (reviewer repro)', async () => {
    s = await startGraphQL([M], { parseOptions: { maxTokens: Infinity } });
    const query = `{ tree { n } } fragment Unused on Tree { ${'n '.repeat(2900)}}`;
    const started = performance.now();
    const res = await s.app.graphql(query);
    expect(performance.now() - started).toBeLessThan(50);
    expect(res.errors?.[0]?.extensions?.code).toBe('FIELD_LIMIT');
  });

  test('9,300 __typename are rejected quickly and not cached', async () => {
    s = await startGraphQL([M], { parseOptions: { maxTokens: Infinity } });
    const before = await cacheSize();
    const started = performance.now();
    const res = await s.app.graphql(`{ ${'__typename '.repeat(9300)}}`);
    expect(performance.now() - started).toBeLessThan(50);
    expect(res.errors?.[0]?.extensions?.code).toBe('FIELD_LIMIT');
    expect(await cacheSize()).toBe(before);
  });

  test('10k repeated fields are rejected before validation in under 50 ms', async () => {
    s = await startGraphQL([M], { parseOptions: { maxTokens: Infinity }, maxAliases: false });
    const query = `{ tree { ${'n '.repeat(10_000)}} }`;
    await s.app.graphql('{ tree { n } }'); // warm up
    const started = performance.now();
    const res = await s.app.graphql(query);
    expect(performance.now() - started).toBeLessThan(50);
    expect(res.errors?.[0]?.extensions?.code).toBe('FIELD_LIMIT');
  });

  test('maxFields can be raised or disabled, and is validated', async () => {
    expect(resolveOptions({ maxFields: false }, '/graphql').maxFields).toBe(false);
    expect(resolveOptions({ maxFields: 5000 }, '/graphql').maxFields).toBe(5000);
    for (const bad of [0, -1, 1.5]) {
      expect(() => resolveOptions({ maxFields: bad }, '/graphql')).toThrow(HttpConfigError);
    }
  });

  test('a custom cache is kept', () => {
    expect(resolveOptions({ cache: false }, '/graphql').executor.cache).toBe(false);
    expect(resolveOptions({ cache: { maxSize: 5 } }, '/graphql').executor.cache).toEqual({
      maxSize: 5,
    });
  });
});

describe('maxIntrospectionDepth', () => {
  /** `{ __schema { types { fields { type { ofType { ofType ... { name } } } } } } }` */
  const bomb = (levels: number) =>
    `{ __schema { types { fields { type { ${'ofType { '.repeat(levels)}name${' }'.repeat(levels)} } } } } }`;

  test('the standard introspection query passes (depth 15)', async () => {
    s = await startGraphQL([M], { introspection: true });
    expect((await s.app.graphql(getIntrospectionQuery())).errors).toBeUndefined();
    expect(resolveOptions({}, '/graphql').maxIntrospectionDepth).toBe(15);
  });

  test('a deeper introspection bomb is DEPTH_LIMIT', async () => {
    s = await startGraphQL([M], { introspection: true });
    // __schema(1) types(2) fields(3) type(4) + levels ofType + name.
    expect((await s.app.graphql(bomb(10))).errors).toBeUndefined(); // depth 15
    const res = await s.app.graphql(bomb(11)); // depth 16
    expect(res.data).toBeUndefined();
    expect(res.errors?.[0]).toMatchObject({
      message: 'Introspection depth of 16 exceeds maximum allowed depth of 15',
      extensions: { code: 'DEPTH_LIMIT' },
    });
  });

  test('a bomb through fragments and __type is caught too', async () => {
    s = await startGraphQL([M], { introspection: true });
    const res = await s.app.graphql(
      `{ __type(name: "Tree") { ...T } } fragment T on __Type { fields { type { ${'ofType { '.repeat(20)}name${' }'.repeat(20)} } } }`,
    );
    expect(res.errors?.[0]?.extensions?.code).toBe('DEPTH_LIMIT');
  });

  test("Leaven's complexity counts introspection fields", async () => {
    s = await startGraphQL([M], { introspection: true, maxComplexity: 5 });
    const res = await s.app.graphql('{ __schema { types { name kind description } } }');
    expect(res.errors?.[0]?.extensions?.code).toBe('COMPLEXITY_LIMIT');
  });

  test('configurable and validated', () => {
    expect(resolveOptions({ maxIntrospectionDepth: false }, '/graphql').maxIntrospectionDepth).toBe(
      false,
    );
    expect(() => resolveOptions({ maxIntrospectionDepth: 0 }, '/graphql')).toThrow(HttpConfigError);
  });
});
