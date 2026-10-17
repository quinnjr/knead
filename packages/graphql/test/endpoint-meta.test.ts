import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@knead-js/core';
import { APP_GUARD, type Ctx } from '@knead-js/http';
import { Test, type TestingModule } from '@knead-js/testing';
import {
  GRAPHQL_ENDPOINT,
  type GraphQLEndpointGuards,
  GraphQLModule,
  Int,
  Query,
  Resolver,
  type ResolverCtx,
} from '../src/index.js';

@Resolver()
class Hello {
  @Query(() => Int) one() {
    return 1;
  }
}

@Module({ providers: [Hello] })
class HelloModule {}

const ResolverGuard = (_ctx: ResolverCtx) => true;

let seen: unknown[] = [];
const recordEndpoint = (ctx: Ctx) => {
  const endpoint = ctx.meta[GRAPHQL_ENDPOINT] as GraphQLEndpointGuards | undefined;
  seen.push(endpoint === undefined ? 'none' : endpoint());
  return true;
};

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
  seen = [];
});

describe('GRAPHQL_ENDPOINT route meta', () => {
  test('is Symbol.for("knead:gql:endpoint")', () => {
    expect(GRAPHQL_ENDPOINT as symbol).toBe(Symbol.for('knead:gql:endpoint'));
  });

  test('exposes the module guards to app-wide HTTP guards', async () => {
    mod = await Test.createModule({
      imports: [GraphQLModule.forRoot({ guards: [ResolverGuard] }), HelloModule],
      providers: [{ provide: APP_GUARD, multi: true, useValue: recordEndpoint }],
    }).compile({ development: false });
    const app = await mod.createApp();
    expect((await app.graphql('{ one }')).data).toEqual({ one: 1 });
    expect(seen).toEqual([[ResolverGuard]]);
  });

  test('reflects options from forRootAsync', async () => {
    mod = await Test.createModule({
      imports: [
        GraphQLModule.forRootAsync({ useFactory: async () => ({ guards: [ResolverGuard] }) }),
        HelloModule,
      ],
      providers: [{ provide: APP_GUARD, multi: true, useValue: recordEndpoint }],
    }).compile({ development: false });
    const app = await mod.createApp();
    await app.graphql('{ one }');
    expect(seen).toEqual([[ResolverGuard]]);
  });

  test('is an empty list when the module has no guards', async () => {
    mod = await Test.createModule({
      imports: [GraphQLModule.forRoot({}), HelloModule],
      providers: [{ provide: APP_GUARD, multi: true, useValue: recordEndpoint }],
    }).compile({ development: false });
    const app = await mod.createApp();
    await app.graphql('{ one }');
    expect(seen).toEqual([[]]);
  });
});
