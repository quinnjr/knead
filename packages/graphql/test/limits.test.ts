import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import { HttpConfigError } from '@hpmws/http';
import {
  Field,
  Int,
  ObjectType,
  Query,
  Resolver,
  resolveOptions,
  Subscription,
} from '../src/index.js';
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
    expect(o.executor.maxDepth).toBe(10);
    expect(o.executor.maxComplexity).toBe(1000);
    expect(o.executor.parseOptions?.maxTokens).toBe(10_000);
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
    expect(o.executor.maxDepth).toBeUndefined();
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

  test('maxTokens 10000', async () => {
    s = await startGraphQL([M]);
    const res = await s.app.graphql(`{ tree { ${'n '.repeat(10_001)}} }`);
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
