import { afterEach, expect, test } from 'bun:test';
import { Module } from '@knead-js/core';
import { readSse } from '@knead-js/testing';
import {
  GraphQLRuntime,
  Int,
  PUBSUB,
  type PubSub,
  Query,
  Resolver,
  Subscription,
} from '../src/index.js';
import { type Started, startGraphQL, until } from './helpers.js';

// Over the maxFields: 2 limit below: three root fields.
const OVER_LIMIT = '{ x: __typename a: __typename b: __typename }';

let runtime: GraphQLRuntime | undefined;
let nested: Record<string, unknown>[] = [];
let later: ReturnType<typeof setTimeout> | undefined;

const codeOf = async (query: string) => {
  const { response } = await runtime!.executor.execute({ query });
  return response.errors?.[0]?.extensions?.code ?? 'ok';
};

@Resolver()
class R {
  @Query(() => Int) n() {
    return 1;
  }

  @Subscription(() => Int, {
    topic: 't',
    guards: [
      async () => {
        nested.push({ guard: await codeOf(OVER_LIMIT) });
        later = setTimeout(async () => {
          nested.push({ timer: await codeOf(OVER_LIMIT) });
        }, 5);
        return true;
      },
    ],
  })
  t() {}
}

@Module({ providers: [R] })
class M {}

let s: Started | undefined;

afterEach(async () => {
  clearTimeout(later);
  await s?.mod.close();
  s = undefined;
  runtime = undefined;
  nested = [];
});

test('executor calls made from subscribe-time code of an SSE subscription keep the document limits and pre-execution hooks', async () => {
  let parses = 0;
  let validates = 0;
  s = await startGraphQL([M], {
    maxFields: 2,
    hooks: {
      onParse: () => {
        parses++;
      },
      onValidated: () => {
        validates++;
      },
    },
  });
  runtime = s.mod.get(GraphQLRuntime);
  const res = await fetch(new URL('/graphql', s.app.url), {
    method: 'POST',
    headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'subscription { t }' }),
  });
  expect(res.status).toBe(200);
  const events = readSse(res);
  await until(() => (s!.mod.get(PUBSUB) as PubSub).getSubscriberCount('t') === 1);
  await until(() => nested.length === 2);
  expect(nested).toEqual([{ guard: 'FIELD_LIMIT' }, { timer: 'FIELD_LIMIT' }]);
  // One for the SSE request (its second, subscribe call skips them), one per nested call.
  expect(parses).toBe(3);
  // The nested documents stop at maxFields, before validation; the subscription validates once.
  expect(validates).toBe(1);
  await events.return?.(undefined);
});
