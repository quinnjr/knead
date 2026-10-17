import { afterEach, describe, expect, test } from 'bun:test';
import type { ModuleImport, Provider } from '@knead-js/core';
import {
  GRAPHQL_LIMITS,
  GraphQLModule,
  type GraphQLModuleOptions,
  GraphQLRuntime,
  MASKED_MESSAGE,
  PLAYGROUND_SCRIPT_HASHES,
  PUBSUB,
  printSortedSchema,
  Query,
  RedisPubSub,
  Resolver,
  resolveOptions,
} from '@knead-js/graphql';
import { HttpConfigError } from '@knead-js/http';
import { SecurityHeadersModule } from '@knead-js/security-headers';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import { getIntrospectionQuery } from 'graphql';
import { AppModule } from '../snippets/graphql/app.module.js';
import { AuthorsById } from '../snippets/graphql/blog.service.js';
import { Lists } from '../snippets/graphql/blog.types.js';
import { EditorResolver, ErrorsAppModule } from '../snippets/graphql/errors.js';
import { GuardedAppModule } from '../snippets/graphql/guards.js';
import { ReportResolver, ReportsAppModule } from '../snippets/graphql/limits.js';
import { PlaygroundAppModule } from '../snippets/graphql/playground.js';
import { SignOutService } from '../snippets/graphql/revocation.js';
import { SessionModule } from '../snippets/graphql/sessions.js';
import { StaticAppModule } from '../snippets/graphql/sync-module.js';

let mod: TestingModule | undefined;

afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

interface Boot {
  imports: ModuleImport[];
  providers?: Provider[];
  development?: boolean;
}

async function boot({ imports, providers = [], development = false }: Boot): Promise<TestApp> {
  mod = await Test.createModule({ imports, providers }).compile({ development });
  return mod.createApp();
}

@Resolver()
class Hello {
  @Query(() => String) hello(): string {
    return 'world';
  }
}

/** A minimal app with GraphQLModule.forRoot(options). */
function minimal(options: GraphQLModuleOptions = {}, development = false): Promise<TestApp> {
  return boot({
    imports: [GraphQLModule.forRoot({ emitSchemaFile: false, ...options })],
    providers: [Hello],
    development,
  });
}

const sdl = () => printSortedSchema(mod!.get(GraphQLRuntime).schema);

describe('graphql: schema', () => {
  test('the blog types produce the documented SDL', async () => {
    await boot({ imports: [AppModule] });
    const schema = sdl();
    expect(schema).toContain('type Post implements Node {');
    expect(schema).toContain('  author: Author!');
    expect(schema).toContain('  publishedAt: DateTime\n');
    expect(schema).toContain('  tags: [String!]!');
    expect(schema).toContain('  words: Int!');
    expect(schema).toContain('  rating: Float\n');
    expect(schema).toContain(
      'posts(first: Int! = 10, offset: Int! = 0, status: PostStatus): [Post!]!',
    );
    expect(schema).toContain('post(id: ID!): Post\n');
    expect(schema).toContain('union SearchResult = Author | Post');
    expect(schema).toContain('interface Node {');
    expect(schema).toContain('enum PostStatus {');
    expect(schema).toContain('"""Visible to its author only"""\n  DRAFT');
    expect(schema).toContain('scalar DateTime');
    expect(schema).toContain('input CreatePostInput {');
    expect(schema).toContain('  publish: Boolean = false');
    expect(schema).toContain('createPost(input: CreatePostInput!): Post!');
    expect(schema).toContain('postPublished(authorId: ID): Post!');
    expect(schema).toContain('message(room: ID!): String!');
  });

  test('list nullability', async () => {
    await boot({
      imports: [GraphQLModule.forRoot({ emitSchemaFile: false, orphanedTypes: [Lists] })],
      providers: [Hello],
    });
    const schema = sdl();
    expect(schema).toContain('  required: [String!]!');
    expect(schema).toContain('  items: [String]!');
    expect(schema).toContain('  list: [String!]\n');
    expect(schema).toContain('  both: [String]\n');
  });

  test('forRoot path', async () => {
    const app = await boot({ imports: [StaticAppModule] });
    const res = await app.graphql('{ post(id: "p1") { title } }', { path: '/api/graphql' });
    expect(res.data).toEqual({ post: { title: 'Notes on the Analytical Engine' } });
    expect((await app.graphql('{ __typename }')).status).toBe(404);
  });
});

describe('graphql: resolvers', () => {
  test('a loader batches every author of one operation', async () => {
    const app = await boot({ imports: [AppModule] });
    const res = await app.graphql('{ posts { title author { name } } }');
    expect(res.data).toEqual({
      posts: [
        { title: 'Notes on the Analytical Engine', author: { name: 'Ada Lovelace' } },
        { title: 'The first actual bug', author: { name: 'Grace Hopper' } },
        { title: 'Poetical science', author: { name: 'Ada Lovelace' } },
      ],
    });
    expect(mod!.get(AuthorsById).calls).toBe(1);
    await app.graphql('{ posts { author { name } } }');
    expect(mod!.get(AuthorsById).calls).toBe(2);
  });

  test('validate failures are BAD_USER_INPUT with issues', async () => {
    const app = await boot({ imports: [AppModule] });
    const res = await app.graphql('{ posts(first: 100) { title } }');
    expect(res.data).toBeNull();
    expect(res.errors).toHaveLength(1);
    expect(res.errors?.[0]).toMatchObject({
      message: 'Argument validation failed',
      path: ['posts'],
      extensions: {
        code: 'BAD_USER_INPUT',
        issues: [{ arg: 'first', message: expect.any(String), path: [] }],
      },
    });
  });

  test('validate replaces the argument with the schema output', async () => {
    const app = await boot({ imports: [AppModule] });
    const res = await app.graphql(
      'mutation { createPost(input: { title: "  Hello  ", tags: ["Bun", " GraphQL "] }) { title tags status } }',
      { headers: { authorization: 'Bearer grace-token' } },
    );
    expect(res.data).toEqual({
      createPost: { title: 'Hello', tags: ['bun', 'graphql'], status: 'DRAFT' },
    });
  });

  test('variable coercion errors are BAD_USER_INPUT, literal ones have no code', async () => {
    const app = await boot({ imports: [AppModule] });
    const variable = await app.graphql('query ($first: Int!) { posts(first: $first) { id } }', {
      variables: { first: 'x' },
    });
    expect(variable.errors?.[0]).toMatchObject({
      message:
        'Variable "$first" got invalid value "x"; Int cannot represent non-integer value: "x"',
      extensions: { code: 'BAD_USER_INPUT' },
    });
    const literal = await app.graphql('{ posts(first: "x") { id } }');
    expect(literal.errors?.[0]?.extensions).toBeUndefined();
  });

  test('an HttpException keeps its code and message', async () => {
    const app = await boot({ imports: [AppModule] });
    const res = await app.graphql('mutation { createPost(input: { title: "Hello" }) { id } }');
    expect(res.errors?.[0]).toMatchObject({
      message: 'Sign in to write posts.',
      extensions: { code: 'UNAUTHENTICATED' },
    });
  });

  test('unions and interfaces resolve by class', async () => {
    const app = await boot({ imports: [AppModule] });
    const res = await app.graphql(
      '{ search(term: "ada") { __typename ... on Author { name } } node(id: "p2") { __typename id } }',
    );
    expect(res.data).toEqual({
      search: [{ __typename: 'Author', name: 'Ada Lovelace' }],
      node: { __typename: 'Post', id: 'p2' },
    });
  });

  test('ArgsOf types the inline arguments', async () => {
    const app = await boot({ imports: [AppModule] });
    expect((await app.graphql('{ post(id: "nope") { id } }')).data).toEqual({ post: null });
  });
});

describe('graphql: subscriptions', () => {
  test('a published post reaches a filtered subscriber', async () => {
    const app = await boot({ imports: [AppModule] });
    const sub = await app.graphqlSubscribe<{ postPublished: { title: string } }>(
      'subscription { postPublished(authorId: "a2") { title } }',
      { connectionParams: { token: 'grace-token' } },
    );
    await Bun.sleep(50);
    for (const token of ['ada-token', 'grace-token']) {
      await app.graphql(
        `mutation { createPost(input: { title: "By ${token}", publish: true }) { id } }`,
        { headers: { authorization: `Bearer ${token}` } },
      );
    }
    expect((await sub.next()).value).toEqual({
      data: { postPublished: { title: 'By grace-token' } },
    });
    await sub.close();
  });

  test('a computed topic and resolve', async () => {
    const app = await boot({ imports: [AppModule] });
    const sub = await app.graphqlSubscribe('subscription { message(room: "r1") }', {
      connectionParams: { token: 'ada-token' },
    });
    await Bun.sleep(50);
    const payload = { text: 'hi' };
    mod!.get(PUBSUB).publish('chat.r1', payload);
    expect((await sub.next()).value).toEqual({ data: { message: 'hi' } });
    // Payloads are deep-frozen when they arrive.
    expect(Object.isFrozen(payload)).toBe(true);
    await sub.close();
  });

  test('a wildcard in a computed topic is BAD_USER_INPUT', async () => {
    const app = await boot({ imports: [AppModule] });
    const sub = await app.graphqlSubscribe('subscription { message(room: "*") }', {
      connectionParams: { token: 'ada-token' },
    });
    const { value } = await sub.next();
    expect(value?.errors?.[0]).toMatchObject({
      message: 'Subscription topics cannot contain "*" or "#".',
      extensions: { code: 'BAD_USER_INPUT' },
    });
    await sub.close();
  });

  test('onConnect returning false closes with 4403', async () => {
    const app = await boot({ imports: [AppModule] });
    await expect(
      app.graphqlSubscribe('subscription { message(room: "r1") }', {
        connectionParams: { token: 'wrong' },
      }),
    ).rejects.toThrow('4403');
  });

  test('a query over WebSocket is rejected', async () => {
    const app = await boot({ imports: [AppModule] });
    const sub = await app.graphqlSubscribe('{ posts { id } }', {
      connectionParams: { token: 'ada-token' },
    });
    const { value } = await sub.next();
    expect(value?.errors?.[0]).toMatchObject({
      message: 'Only subscription operations are allowed over WebSocket.',
      extensions: { code: 'BAD_USER_INPUT' },
    });
    await sub.close();
  });

  test('closeWhere closes the matching sockets', async () => {
    const app = await boot({ imports: [AppModule, SessionModule], providers: [SignOutService] });
    const sub = await app.graphqlSubscribe('subscription { message(room: "r1") }', {
      connectionParams: { token: 'grace-token' },
    });
    const other = await app.graphqlSubscribe('subscription { message(room: "r1") }', {
      connectionParams: { token: 'ada-token' },
    });
    await Bun.sleep(50);
    expect(mod!.get(SignOutService).signOut('grace-token', 'a2')).toBe(1);
    // A revoked subscription is not a completed one: next() rejects with the close code.
    const revoked = (await sub.next().catch((error: unknown) => error)) as Error;
    expect(revoked.message).toBe('WebSocket closed: 1008 Connection revoked');
    mod!.get(PUBSUB).publish('chat.r1', { text: 'still here' });
    expect((await other.next()).value).toEqual({ data: { message: 'still here' } });
    await other.close();
  });
});

describe('graphql: guards', () => {
  const ada = { headers: { authorization: 'Bearer ada-token' } };
  const grace = { headers: { authorization: 'Bearer grace-token' } };
  const code = (res: { errors?: { extensions?: Record<string, unknown> }[] }) =>
    res.errors?.[0]?.extensions?.code;

  test('module guards, @Public and defaultDeny', async () => {
    const app = await boot({ imports: [GuardedAppModule] });
    expect((await app.graphql('{ health }')).data).toEqual({ health: 'ok' });
    const anonymous = await app.graphql('{ me { id } }');
    expect(anonymous.errors?.[0]).toMatchObject({
      message: 'Forbidden',
      extensions: { code: 'FORBIDDEN' },
    });
    expect((await app.graphql('{ me { id name } }', grace)).data).toEqual({
      me: { id: 'a2', name: 'Grace Hopper' },
    });
    expect(code(await app.graphql('{ postCount }', ada))).toBe('FORBIDDEN');
  });

  test('route metadata, validate and authorize', async () => {
    const app = await boot({ imports: [GuardedAppModule] });
    expect(code(await app.graphql('mutation { transfer(amount: 50) }', grace))).toBe('FORBIDDEN');
    expect((await app.graphql('mutation { transfer(amount: 50) }', ada)).data).toEqual({
      transfer: 50,
    });
    expect(code(await app.graphql('mutation { transfer(amount: 500) }', ada))).toBe('FORBIDDEN');
    expect(code(await app.graphql('mutation { transfer(amount: 0) }', ada))).toBe('BAD_USER_INPUT');
    // Guards run before validate: a member without the role never reaches validation.
    expect(code(await app.graphql('mutation { transfer(amount: 0) }', grace))).toBe('FORBIDDEN');
  });

  test('field guards null a denied object', async () => {
    const app = await boot({ imports: [GuardedAppModule] });
    const res = await app.graphql('{ account(id: "a1") { id name } }', grace);
    expect(res.data).toEqual({ account: null });
    expect(res.errors?.map((e) => e.extensions?.code)).toContain('FORBIDDEN');
  });
});

describe('graphql: errors', () => {
  test('production: codes, mapError and masking', async () => {
    const app = await boot({ imports: [ErrorsAppModule] });
    expect((await app.graphql('{ draft(id: "d1") }')).errors?.[0]).toMatchObject({
      message: 'No draft d1',
      extensions: { code: 'NOT_FOUND' },
    });
    expect((await app.graphql('mutation { rename(id: "d1") }')).errors?.[0]).toMatchObject({
      message: 'The new title of d1 is taken.',
      extensions: { code: 'BAD_USER_INPUT', field: 'title' },
    });
    expect((await app.graphql('mutation { edit(id: "d1") }')).errors?.[0]).toMatchObject({
      message: 'Post d1 is locked',
      extensions: { code: 'FORBIDDEN' },
    });
    const report = await app.graphql('{ report }');
    expect(report.status).toBe(200);
    const error = report.errors?.[0];
    expect(error?.message).toBe(MASKED_MESSAGE);
    expect(error?.message).toBe('Internal server error');
    expect(error?.extensions).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      correlationId: expect.any(String),
    });
    const logged = JSON.stringify(mod!.logs);
    expect(logged).toContain(String(error?.extensions?.correlationId));
    expect(logged).not.toContain('hunter2');
  });

  test('development: the message is not masked', async () => {
    const app = await boot({
      imports: [GraphQLModule.forRoot({ emitSchemaFile: false })],
      providers: [EditorResolver],
      development: true,
    });
    const report = await app.graphql('{ report }');
    expect(report.errors?.[0]?.message).toStartWith('connect ECONNREFUSED');
    expect(report.errors?.[0]?.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
  });
});

describe('graphql: HTTP transport', () => {
  test('POST, GET and their rules', async () => {
    const app = await boot({ imports: [AppModule] });
    const ok = await app.graphql('{ posts { id } }');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');

    const text = await app.request('POST', '/graphql', {
      headers: { 'content-type': 'text/plain' },
      body: '{"query":"{ posts { id } }"}',
    });
    expect(text.status).toBe(415);

    const noHeader = await app.request('GET', '/graphql', { query: { query: '{ posts { id } }' } });
    expect(noHeader.status).toBe(400);
    const get = await app.request('GET', '/graphql', {
      query: { query: '{ post(id: "p1") { id } }' },
      headers: { 'x-graphql-request': '1' },
    });
    expect(await get.json()).toEqual({ data: { post: { id: 'p1' } } });
    const mutation = await app.request('GET', '/graphql', {
      query: { query: 'mutation { createPost(input: { title: "Nope" }) { id } }' },
      headers: { 'x-graphql-request': '1' },
    });
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get('allow')).toBe('POST');

    const subscription = await app.graphql('subscription { message(room: "r1") }');
    expect(subscription.status).toBe(400);

    const strict = await app.request('POST', '/graphql', {
      headers: { accept: 'application/graphql-response+json' },
      json: { query: '{ nope }' },
    });
    expect(strict.status).toBe(400);
    expect(strict.headers.get('content-type')).toBe(
      'application/graphql-response+json; charset=utf-8',
    );
    expect((await app.graphql('{ nope }')).status).toBe(200);
  });
});

describe('graphql: limits', () => {
  test('GRAPHQL_LIMITS', () => {
    expect(GRAPHQL_LIMITS).toEqual({
      maxDepth: 10,
      maxComplexity: 1000,
      maxTokens: 3000,
      maxQueryLength: 102400,
      maxAliases: 30,
      maxFields: 1000,
      maxIntrospectionDepth: 20,
    });
  });

  test('each default limit rejects', async () => {
    const app = await minimal();
    const first = async (query: string) => (await app.graphql(query)).errors?.[0];

    const deep = `{ ${'a { '.repeat(10)}b${' }'.repeat(10)} }`;
    expect(await first(deep)).toMatchObject({
      message: 'Query depth of 11 exceeds maximum allowed depth of 10',
      extensions: { code: 'DEPTH_LIMIT' },
    });

    const aliases = `{ ${Array.from({ length: 31 }, (_, i) => `a${i}: hello`).join(' ')} }`;
    expect(await first(aliases)).toMatchObject({
      message: 'The document has 31 aliases; at most 30 are allowed.',
      extensions: { code: 'BAD_USER_INPUT' },
    });

    const fields = `{ ${'hello '.repeat(1001)}}`;
    expect(await first(fields)).toMatchObject({
      message: 'The document selects more than 1000 fields.',
      extensions: { code: 'FIELD_LIMIT' },
    });

    const args = Array.from({ length: 1100 }, (_, i) => `a${i}: 1`).join(', ');
    const tokens = `{ hello(${args}) }`;
    expect((await first(tokens))?.message).toContain('3000');

    const long = await app.graphql(`{ hello }${' '.repeat(102400)}`);
    expect(long.status).toBe(400);
    expect(JSON.stringify(long)).toContain('The query is longer than 102400 characters.');
  });

  test('complexity uses field costs', async () => {
    mod = await Test.createModule({ imports: [ReportsAppModule] }).compile({ development: false });
    const app = await mod.createApp();
    expect((await app.graphql('{ reports { id rows } }')).data).toEqual({
      reports: [{ id: 1, rows: ['a', 'b'] }],
    });
    await mod.close();
    const costly = await boot({
      imports: [GraphQLModule.forRoot({ emitSchemaFile: false, maxComplexity: 40 })],
      providers: [ReportResolver],
    });
    // 10 + (1 + 0.5) + (25 + 0.5) = 37
    expect((await costly.graphql('{ reports { id rows } }')).errors).toBeUndefined();
    // + (25 + 0.5) for the aliased second selection of rows
    expect((await costly.graphql('{ reports { id rows more: rows } }')).errors?.[0]).toMatchObject({
      message: 'Query complexity of 62.5 exceeds maximum allowed complexity of 40',
      extensions: { code: 'COMPLEXITY_LIMIT' },
    });
  });

  test('complexity limit', async () => {
    const app = await minimal({ maxComplexity: 5 });
    const res = await app.graphql(`{ ${'hello '.repeat(6)}}`);
    expect(res.errors?.[0]).toMatchObject({
      message: 'Query complexity of 6 exceeds maximum allowed complexity of 5',
      extensions: { code: 'COMPLEXITY_LIMIT' },
    });
  });

  test('introspection is off in production and on in development', async () => {
    const prod = await minimal();
    const denied = await prod.graphql('{ __schema { queryType { name } } }');
    expect(denied.errors?.[0]?.message).toContain('introspection has been disabled');
    expect((await prod.graphql('{ __typename }')).data).toEqual({ __typename: 'Query' });
    await mod?.close();
    const dev = await minimal({}, true);
    const full = await dev.graphql(getIntrospectionQuery());
    expect(full.errors).toBeUndefined();
  });
});

describe('graphql: options', () => {
  test('development decides the defaults', () => {
    const prod = resolveOptions({}, '/graphql', false);
    expect(prod).toMatchObject({
      playground: false,
      introspection: false,
      maskErrors: true,
      emitSchemaFile: false,
      cacheControl: 'no-store',
      csrf: { requiredHeaders: ['x-graphql-request'] },
      defaultDeny: false,
    });
    const dev = resolveOptions({}, '/graphql', true);
    expect(dev).toMatchObject({
      playground: true,
      introspection: true,
      maskErrors: false,
      emitSchemaFile: 'schema.graphql',
    });
    expect(resolveOptions({ playground: true }, '/graphql', false).introspection).toBe(true);
  });

  test('invalid limits are configuration errors', () => {
    expect(() => GraphQLModule.forRoot({ maxDepth: 0 })).toThrow(HttpConfigError);
    expect(() => GraphQLModule.forRoot({ maxDepth: 0 })).toThrow(
      'GraphQL maxDepth must be a positive integer, Infinity or false; got 0.',
    );
    expect(() => GraphQLModule.forRoot({ path: '/graphql/:id' })).toThrow(
      'GraphQL path must be exact',
    );
  });

  test('RedisPubSub rejects short keys before connecting', () => {
    expect(() => new RedisPubSub({ signingKey: 'too short' })).toThrow(
      'RedisPubSub signingKey keys must be at least 32 bytes.',
    );
  });
});

describe('graphql: playground', () => {
  test('explicitly enabled outside development, with its own CSP', async () => {
    mod = await Test.createModule({ imports: [PlaygroundAppModule] }).compile({
      development: false,
    });
    const app = await mod.createApp();
    const res = await app.request('GET', '/graphql', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.text()).toContain('wss://api.example.com/graphql');
    // Enabled outside development: a warning is logged at bootstrap.
    expect(mod.logs.some((e) => e.level === 'warn' && e.message.includes('playground'))).toBe(true);
    // An explicit playground turns introspection on.
    expect((await app.graphql('{ __schema { queryType { name } } }')).data).toEqual({
      __schema: { queryType: { name: 'Query' } },
    });
  });

  test('the reference page script hash', async () => {
    const app = await minimal({ playground: true });
    const res = await app.request('GET', '/graphql', { headers: { accept: 'text/html' } });
    expect(res.headers.get('content-security-policy')).toContain(
      `'sha256-${PLAYGROUND_SCRIPT_HASHES[0]}'`,
    );
  });

  test('SecurityHeadersModule keeps the playground CSP', async () => {
    const app = await boot({
      imports: [
        SecurityHeadersModule.forRoot(),
        GraphQLModule.forRoot({ emitSchemaFile: false, playground: true }),
      ],
      providers: [Hello],
    });
    const res = await app.request('GET', '/graphql', { headers: { accept: 'text/html' } });
    expect(res.headers.get('content-security-policy')).toContain(
      `'sha256-${PLAYGROUND_SCRIPT_HASHES[0]}'`,
    );
  });

  test('off in production: a browser GET is a CSRF-checked query', async () => {
    const app = await minimal();
    const res = await app.request('GET', '/graphql', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(400);
  });
});
