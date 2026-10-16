import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import { Int, Query, Resolver, type ResolverCtx } from '../src/index.js';
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
