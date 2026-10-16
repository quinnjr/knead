import { describe, expect, test } from 'bun:test';
import { eventIterator, PubSub } from '../src/index.js';

describe('eventIterator', () => {
  test('yields events from every topic in order, buffering until pulled', async () => {
    const pubsub = new PubSub();
    const it = eventIterator<number>(pubsub, ['a', 'b']);
    pubsub.publish('a', 1);
    pubsub.publish('b', 2);
    expect(await it.next()).toEqual({ value: 1, done: false });
    expect(await it.next()).toEqual({ value: 2, done: false });
    const pending = it.next();
    pubsub.publish('a', 3);
    expect(await pending).toEqual({ value: 3, done: false });
  });

  test('filter skips events; return() unsubscribes and ends pending pulls', async () => {
    const pubsub = new PubSub();
    const it = eventIterator<number>(pubsub, ['n'], (n) => n % 2 === 0);
    pubsub.publish('n', 1);
    pubsub.publish('n', 2);
    expect(await it.next()).toEqual({ value: 2, done: false });
    const pending = it.next();
    await it.return!();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(pubsub.getSubscriberCount('n')).toBe(0);
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  test('a slow consumer keeps only the newest 1000 events', async () => {
    const pubsub = new PubSub();
    const it = eventIterator<number>(pubsub, ['x']);
    for (let i = 0; i < 1005; i++) pubsub.publish('x', i);
    expect((await it.next()).value).toBe(5);
    await it.return!();
  });
});
