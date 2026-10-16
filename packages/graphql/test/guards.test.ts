import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import { HttpConfigError, UseGuards } from '@hpmws/http';
import {
  Field,
  Int,
  IS_PUBLIC,
  Mutation,
  ObjectType,
  Public,
  Query,
  ResolveField,
  Resolver,
  type ResolverCtx,
  Subscription,
} from '../src/index.js';
import { type Started, startGraphQL } from './helpers.js';

const truthy = [1, 'yes', {}, [], Promise.resolve('ok')];
let verdict: unknown = true;
const Verdict = (_ctx: ResolverCtx) => verdict as boolean;

@Resolver()
class Strict {
  @Query(() => Int, { guards: [Verdict] }) guarded() {
    return 1;
  }
}

@Module({ providers: [Strict] })
class StrictModule {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

describe('resolver guards pass only on === true', () => {
  test('true passes; truthy non-true values are FORBIDDEN', async () => {
    s = await startGraphQL([StrictModule]);
    verdict = true;
    expect((await s.app.graphql('{ guarded }')).data).toEqual({ guarded: 1 });
    for (const value of truthy) {
      verdict = value;
      const res = await s.app.graphql('{ guarded }');
      expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    }
    verdict = Promise.resolve(true);
    expect((await s.app.graphql('{ guarded }')).data).toEqual({ guarded: 1 });
  });
});

const calls: string[] = [];
const ModuleGuard = (ctx: ResolverCtx) => {
  calls.push(`module:${ctx.info.fieldName}`);
  return ctx.http.req.headers.has('x-ok');
};
const ClassGuard = (ctx: ResolverCtx) => {
  calls.push(`class:${ctx.info.fieldName}`);
  return true;
};

@ObjectType()
class Item {
  @Field(() => Int) id!: number;
}

@Resolver(() => Item)
class Items {
  @Query(() => Item) item() {
    return { id: 1 };
  }
  @Query(() => Int) @Public() open() {
    return 2;
  }
  @Mutation(() => Int) change() {
    return 3;
  }
  @Subscription(() => Int, { topic: 'items' }) items() {}
  @ResolveField(() => Int) double(ctx: ResolverCtx<{}, Item>) {
    return ctx.parent.id * 2;
  }
}

@Resolver()
@UseGuards(ClassGuard)
class Guarded {
  @Query(() => Int) guardedByClass() {
    return 4;
  }
}

@Module({ providers: [Items, Guarded] })
class ItemsModule {}

describe('module-level guards', () => {
  test('run before class guards on every root field, not on @ResolveField', async () => {
    s = await startGraphQL([ItemsModule], { guards: [ModuleGuard] });
    calls.length = 0;
    const ok = await s.app.graphql('{ item { id double } guardedByClass }', {
      headers: { 'x-ok': '1' },
    });
    expect(ok.data).toEqual({ item: { id: 1, double: 2 }, guardedByClass: 4 });
    expect(calls).toEqual(['module:item', 'module:guardedByClass', 'class:guardedByClass']);
    const denied = await s.app.graphql('{ item { id } }');
    expect(denied.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const mutation = await s.app.graphql('mutation { change }');
    expect(mutation.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  test('run on subscriptions when they subscribe', async () => {
    s = await startGraphQL([ItemsModule], { guards: [ModuleGuard] });
    const sub = await s.app.graphqlSubscribe('subscription { items }');
    const first = await sub.next();
    expect(first.value?.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    await sub.close();
  });

  test('@Public() resolvers skip module guards; the flag is in ctx.meta', async () => {
    let seen: unknown;
    s = await startGraphQL([ItemsModule], {
      guards: [
        (ctx: ResolverCtx) => {
          seen = ctx.meta[IS_PUBLIC];
          return false;
        },
      ],
    });
    expect((await s.app.graphql('{ open }')).data).toEqual({ open: 2 });
    expect(seen).toBeUndefined();
    expect((await s.app.graphql('{ item { id } }')).errors?.[0]?.extensions?.code).toBe(
      'FORBIDDEN',
    );
  });

  test('defaultDeny: root fields need @Public() or a resolver guard', async () => {
    s = await startGraphQL([ItemsModule], { defaultDeny: true });
    const res = await s.app.graphql('{ open guardedByClass }');
    expect(res.data).toEqual({ open: 2, guardedByClass: 4 });
    for (const query of ['{ item { id } }', 'mutation { change }']) {
      const denied = await s.app.graphql(query);
      expect(denied.errors?.[0]).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    }
    const sub = await s.app.graphqlSubscribe('subscription { items }');
    expect((await sub.next()).value?.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    await sub.close();
  });

  test('defaultDeny: module guards alone do not count as authorization', async () => {
    s = await startGraphQL([ItemsModule], { defaultDeny: true, guards: [() => true] });
    const res = await s.app.graphql('{ item { id } }');
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });
});

describe('guard references are validated at bootstrap', () => {
  class ArrowGuard {
    canActivate = () => true;
  }

  test('undefined and arrow-field classes are an HttpConfigError naming the resolver', async () => {
    for (const bad of [undefined, ArrowGuard, {}]) {
      @Resolver()
      class Bad {
        @Query(() => Int, { guards: [bad as never] }) n() {
          return 1;
        }
      }
      @Module({ providers: [Bad] })
      class BadModule {}
      const failure = await startGraphQL([BadModule]).catch((e) => e);
      expect(failure).toBeInstanceOf(HttpConfigError);
      expect((failure as Error).message).toContain('Bad.n');
    }
  });

  test('invalid module guards are rejected too', async () => {
    const failure = await startGraphQL([StrictModule], { guards: [undefined as never] }).catch(
      (e) => e,
    );
    expect(failure).toBeInstanceOf(HttpConfigError);
    expect((failure as Error).message).toContain('GraphQLModule guards');
  });
});

describe('authorize guards run after argument validation', () => {
  const canonical = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (value: unknown) =>
        typeof value === 'string'
          ? { value: value.trim().toLowerCase() }
          : { issues: [{ message: 'string required' }] },
    },
  };
  const seen: { guard: unknown[]; authorize: unknown[] } = { guard: [], authorize: [] };

  @Resolver()
  class Invites {
    @Mutation(() => String, {
      args: { email: String },
      validate: { email: canonical },
      guards: [
        (ctx: ResolverCtx<{ email: string }>) => {
          seen.guard.push(ctx.args.email);
          return true;
        },
      ],
      authorize: [
        (ctx: ResolverCtx<{ email: string }>) => {
          seen.authorize.push(ctx.args.email);
          return ctx.args.email === 'admin@example.com';
        },
      ],
    })
    invite(ctx: ResolverCtx<{ email: string }>) {
      return ctx.args.email;
    }
  }
  @Module({ providers: [Invites] })
  class InvitesModule {}

  test('authorize sees the transformed args; false is FORBIDDEN', async () => {
    s = await startGraphQL([InvitesModule, StrictModule]);
    const ok = await s.app.graphql('mutation { invite(email: "  ADMIN@Example.com ") }');
    expect(ok.data).toEqual({ invite: 'admin@example.com' });
    expect(seen.guard).toEqual(['  ADMIN@Example.com ']);
    expect(seen.authorize).toEqual(['admin@example.com']);
    const denied = await s.app.graphql('mutation { invite(email: "eve@example.com") }');
    expect(denied.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });
});
