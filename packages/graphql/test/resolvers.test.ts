import { afterEach, describe, expect, test } from 'bun:test';
import { inject, Module } from '@hpmws/core';
import {
  BadRequestException,
  ConflictException,
  createRouteDecorator,
  ForbiddenException,
  type Guard,
  NotFoundException,
  TooManyRequestsException,
  UnauthorizedException,
  UseGuards,
} from '@hpmws/http';
import { ErrorCode, LeavenError } from '@leaven-graphql/errors';
import { GraphQLError } from 'graphql';
import { Int, Query, Resolver, type ResolverCtx } from '../src/index.js';
import { BlogModule, Store } from './fixtures/blog.js';
import { type Started, startGraphQL } from './helpers.js';

declare module '../src/index.js' {
  interface GraphQLContext {
    viewer?: string;
  }
}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

const order: string[] = [];
const Roles = createRouteDecorator<string[]>('roles');

class ClassGuard implements Guard<ResolverCtx> {
  canActivate() {
    order.push('class');
    return true;
  }
}
class MethodGuard implements Guard<ResolverCtx> {
  canActivate() {
    order.push('method');
    return true;
  }
}
const RolesGuard = (ctx: ResolverCtx) => {
  const roles = (ctx.meta.roles as string[] | undefined) ?? [];
  return roles.length === 0 || roles.includes(String(ctx.viewer));
};

@Resolver()
@UseGuards(ClassGuard)
class GuardedResolver {
  @Query(() => String, { guards: [MethodGuard] })
  @UseGuards(RolesGuard)
  @Roles(['admin'])
  secret(ctx: ResolverCtx) {
    return `secret for ${ctx.viewer}`;
  }

  @Query(() => String, { meta: { label: 'open' } })
  open(ctx: ResolverCtx) {
    return String(ctx.meta.label);
  }

  @Query(() => Int)
  stateful(ctx: ResolverCtx) {
    ctx.state.n = ((ctx.state.n as number | undefined) ?? 0) + 1;
    return ctx.state.n as number;
  }
}

const errors: Record<string, () => Error> = {
  badRequest: () => new BadRequestException('bad input'),
  unauthorized: () => new UnauthorizedException('who are you'),
  forbidden: () => new ForbiddenException('not yours'),
  notFound: () => new NotFoundException('gone'),
  tooMany: () => new TooManyRequestsException('slow down'),
  leaven: () => new LeavenError('custom', ErrorCode.ALREADY_EXISTS, { extensions: { id: 7 } }),
  graphql: () => new GraphQLError('deliberate', { extensions: { code: 'TEAPOT' } }),
  conflict: () => new ConflictException('other http'),
  crash: () => new Error('database password is hunter2'),
};

@Resolver()
class ErrorResolver {
  @Query(() => String, { nullable: true, args: { kind: String } })
  fail(ctx: ResolverCtx<{ kind: string }>): string {
    throw errors[ctx.args.kind]!();
  }
}

const positive = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) =>
      typeof value === 'number' && value > 0
        ? { value: value * 10 }
        : { issues: [{ message: 'must be positive' }] },
  },
};

@Resolver()
class ValidatedResolver {
  @Query(() => Int, { args: { n: Int }, validate: { n: positive } })
  times(ctx: ResolverCtx<{ n: number }>) {
    return ctx.args.n;
  }
}

@Module({ providers: [GuardedResolver, ErrorResolver, ValidatedResolver] })
class TestResolvers {}

describe('ResolverCtx', () => {
  test('context factory output is merged; state is per operation', async () => {
    s = await startGraphQL([TestResolvers], {
      context: (http) => ({ viewer: http.req.headers.get('x-user') ?? undefined }),
    });
    const res = await s.app.graphql('{ a: stateful b: stateful }', {
      headers: { 'x-user': 'admin' },
    });
    expect(res.data).toEqual({ a: 1, b: 2 });
    const again = await s.app.graphql('{ a: stateful }');
    expect(again.data).toEqual({ a: 1 });
  });

  test('meta from options and createRouteDecorator reaches ctx.meta', async () => {
    s = await startGraphQL([TestResolvers]);
    expect((await s.app.graphql('{ open }')).data).toEqual({ open: 'open' });
  });
});

describe('guards', () => {
  test('class guards run before method guards; meta-driven guard passes', async () => {
    s = await startGraphQL([TestResolvers], { context: () => ({ viewer: 'admin' }) });
    order.length = 0;
    const res = await s.app.graphql('{ secret }');
    expect(res.data).toEqual({ secret: 'secret for admin' });
    expect(order).toEqual(['class', 'method']);
  });

  test('a guard returning false yields FORBIDDEN', async () => {
    s = await startGraphQL([TestResolvers], { context: () => ({ viewer: 'guest' }) });
    const res = await s.app.graphql('{ secret }');
    expect(res.data).toBeNull();
    expect(res.errors?.[0]).toMatchObject({ path: ['secret'], extensions: { code: 'FORBIDDEN' } });
  });
});

describe('error mapping', () => {
  const expected: Record<string, { code: string; message: string }> = {
    badRequest: { code: 'BAD_USER_INPUT', message: 'bad input' },
    unauthorized: { code: 'UNAUTHENTICATED', message: 'who are you' },
    forbidden: { code: 'FORBIDDEN', message: 'not yours' },
    notFound: { code: 'NOT_FOUND', message: 'gone' },
    tooMany: { code: 'RATE_LIMITED', message: 'slow down' },
    leaven: { code: 'ALREADY_EXISTS', message: 'custom' },
    graphql: { code: 'TEAPOT', message: 'deliberate' },
    conflict: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
    crash: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
  };
  for (const [kind, want] of Object.entries(expected)) {
    test(`${kind} → ${want.code}`, async () => {
      s ??= await startGraphQL([TestResolvers]);
      const res = await s.app.graphql('query($k: String!) { fail(kind: $k) }', {
        variables: { k: kind },
      });
      expect(res.status).toBe(200);
      expect(res.errors?.[0]?.message).toBe(want.message);
      expect(res.errors?.[0]?.extensions?.code).toBe(want.code);
    });
  }

  test('LeavenError extensions pass through', async () => {
    s = await startGraphQL([TestResolvers]);
    const res = await s.app.graphql('{ fail(kind: "leaven") }');
    expect(res.errors?.[0]?.extensions).toEqual({ id: 7, code: 'ALREADY_EXISTS' });
  });

  test('maskErrors: false exposes the message; unexpected errors are logged either way', async () => {
    s = await startGraphQL([TestResolvers], { maskErrors: false });
    const res = await s.app.graphql('{ fail(kind: "crash") }');
    expect(res.errors?.[0]?.message).toBe('database password is hunter2');
    expect(s.mod.logs.some((e) => e.level === 'error' && e.message.includes('fail'))).toBe(true);
  });

  test('variable coercion errors are BAD_USER_INPUT', async () => {
    s = await startGraphQL([TestResolvers]);
    const res = await s.app.graphql('query($n: Int!) { times(n: $n) }', { variables: { n: 'x' } });
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  test('depth limit uses Leaven DEPTH_LIMIT', async () => {
    s = await startGraphQL([BlogModule], { maxDepth: 2 });
    const res = await s.app.graphql('{ posts { author { posts { title } } } }');
    expect(res.errors?.[0]?.extensions?.code).toBe('DEPTH_LIMIT');
  });
});

describe('args validate', () => {
  test('validated output replaces the argument', async () => {
    s = await startGraphQL([TestResolvers]);
    expect((await s.app.graphql('{ times(n: 2) }')).data).toEqual({ times: 20 });
  });

  test('failures are BAD_USER_INPUT with issues', async () => {
    s = await startGraphQL([TestResolvers]);
    const res = await s.app.graphql('{ times(n: -1) }');
    expect(res.errors?.[0]).toMatchObject({
      message: 'Argument validation failed',
      extensions: {
        code: 'BAD_USER_INPUT',
        issues: [{ arg: 'n', message: 'must be positive', path: [] }],
      },
    });
  });
});

describe('DataLoader', () => {
  test('one batch per tick per operation, none shared across operations', async () => {
    s = await startGraphQL([BlogModule]);
    const store = s.mod.get(Store);
    store.userBatches = [];
    const res = await s.app.graphql('{ posts { author { name } } }');
    expect(res.data?.posts).toEqual([
      { author: { name: 'Ada' } },
      { author: { name: 'Grace' } },
      { author: { name: 'Ada' } },
    ]);
    expect(store.userBatches).toEqual([['u1', 'u2']]);
    await Promise.all([
      s.app.graphql('{ posts { author { name } } }'),
      s.app.graphql('{ posts { author { name } } }'),
    ]);
    expect(store.userBatches.length).toBe(3);
  });

  test('resolvers in imported modules are discovered and may inject()', async () => {
    @Resolver()
    class R {
      readonly store = inject(Store);
      @Query(() => Int) n() {
        return this.store.users.size;
      }
    }
    @Module({ imports: [BlogModule], providers: [R] })
    class M {}
    s = await startGraphQL([M]);
    expect((await s.app.graphql('{ n }')).data).toEqual({ n: 2 });
  });
});
