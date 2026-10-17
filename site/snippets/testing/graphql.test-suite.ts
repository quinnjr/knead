import { afterEach, expect, test } from 'bun:test';
import {
  type GraphQLPayload,
  type GraphQLSubscription,
  Test,
  type TestingModule,
} from '@knead-js/testing';
import { StockModule } from './stock.graphql.js';

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

// #region query
test('queries stock over HTTP', async () => {
  // development: false keeps production defaults: masked errors, no schema.graphql written.
  mod = await Test.createModule({ imports: [StockModule] }).compile({ development: false });
  const app = await mod.createApp();

  const res = await app.graphql<{ stock: { quantity: number } | null }>(
    'query Stock($sku: ID!) { stock(sku: $sku) { quantity } }',
    { variables: { sku: 'KETTLE-1' } },
  );

  expect(res.status).toBe(200);
  expect(res.errors).toBeUndefined();
  expect(res.data).toEqual({ stock: { quantity: 12 } });
});
// #endregion query

// #region errors
test('reports invalid variables as BAD_USER_INPUT', async () => {
  mod = await Test.createModule({ imports: [StockModule] }).compile({ development: false });
  const app = await mod.createApp();

  const res = await app.graphql('query Stock($sku: ID!) { stock(sku: $sku) { quantity } }');

  expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
});
// #endregion errors

// #region subscription
/**
 * Runs `trigger` until the subscription yields. The server registers a subscription shortly
 * after connection_ack, so an event published right away could be missed.
 */
async function nextEvent<T>(
  subscription: GraphQLSubscription<T>,
  trigger: () => Promise<unknown>,
): Promise<GraphQLPayload<T>> {
  const next = subscription.next();
  for (let attempt = 0; attempt < 40; attempt++) {
    await trigger();
    const result = await Promise.race([next, Bun.sleep(50).then(() => undefined)]);
    if (result?.done) throw new Error('subscription ended without an event');
    if (result) return result.value;
  }
  throw new Error('no subscription event received');
}

test('pushes stock changes to subscribers', async () => {
  mod = await Test.createModule({ imports: [StockModule] }).compile({ development: false });
  const app = await mod.createApp();
  const subscription = await app.graphqlSubscribe<{
    stockChanged: { sku: string; quantity: number };
  }>('subscription { stockChanged { sku quantity } }');

  const event = await nextEvent(subscription, () =>
    app.graphql('mutation { setStock(sku: "KETTLE-1", quantity: 3) { quantity } }'),
  );

  expect(event.data).toEqual({ stockChanged: { sku: 'KETTLE-1', quantity: 3 } });
  await subscription.close();
});
// #endregion subscription
