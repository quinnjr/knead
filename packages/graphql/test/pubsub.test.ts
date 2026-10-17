import { describe, expect, test } from 'bun:test';
import { Module } from '@knead-js/core';
import { deepFreeze, eventIterator, Int, PUBSUB, PubSub, Query, Resolver } from '../src/index.js';
import { startGraphQL } from './helpers.js';

describe('eventIterator', () => {
  test('an engine error ends the iterator with a generic error', async () => {
    let fail: ((error: Error) => void) | undefined;
    const engine = {
      subscribe: (_t: string, _cb: unknown, onError?: (error: Error) => void) => {
        fail = onError;
        return () => {};
      },
      publish: () => {},
    };
    const it = eventIterator<number>(engine, ['x']);
    const pending = it.next();
    fail!(new Error('redis down: secret host'));
    await expect(pending).rejects.toThrow('Subscription event source failed.');
  });

  test('a subscribe throwing partway undoes the topics already subscribed', () => {
    const active = new Set<string>();
    const engine = {
      subscribe: (topic: string) => {
        if (topic === 'b') throw new Error('Maximum subscribers reached');
        active.add(topic);
        return () => active.delete(topic);
      },
      publish: () => {},
    };
    expect(() => eventIterator<number>(engine, ['a', 'b', 'c'])).toThrow(
      'Maximum subscribers reached',
    );
    expect([...active]).toEqual([]);
  });

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
    let dropped = 0;
    const it2 = eventIterator<number>(pubsub, ['x'], undefined, { onDrop: () => dropped++ });
    for (let i = 0; i < 1005; i++) pubsub.publish('x', i);
    expect((await it.next()).value).toBe(5);
    expect(dropped).toBe(5);
    await it2.return!();
    await it.return!();
  });
});

describe('shared payloads are immutable', () => {
  test('the in-memory PubSub deep-freezes a payload even with no subscriber', async () => {
    const pubsub = new PubSub();
    const payload = { user: { name: 'a' }, tags: ['x'] };
    await pubsub.publish('nobody-listens', payload);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.user)).toBe(true);
    expect(Object.isFrozen(payload.tags)).toBe(true);
  });

  test('the PUBSUB default is the freezing in-memory PubSub', async () => {
    @Resolver()
    class R {
      @Query(() => Int) n() {
        return 1;
      }
    }
    @Module({ providers: [R] })
    class M {}
    const { mod } = await startGraphQL([M]);
    try {
      expect(mod.get(PUBSUB)).toBeInstanceOf(PubSub);
    } finally {
      await mod.close();
    }
  });

  test('every subscriber of the in-memory PubSub gets the same deep-frozen payload', async () => {
    const pubsub = new PubSub();
    const a = eventIterator<{ post: { title: string; tags: string[] } }>(pubsub, ['t']);
    const b = eventIterator<{ post: { title: string; tags: string[] } }>(pubsub, ['t']);
    const pa = a.next();
    const pb = b.next();
    await pubsub.publish('t', { post: { title: 'x', tags: ['a'] }, bytes: new Uint8Array(2) });
    const first = (await pa).value!;
    expect(() => {
      first.post.title = 'changed';
    }).toThrow(TypeError);
    expect(() => first.post.tags.push('b')).toThrow(TypeError);
    expect((await pb).value!.post).toEqual({ title: 'x', tags: ['a'] });
    await a.return?.();
    await b.return?.();
  });

  test('class instances, Dates and Maps are left mutable (they belong to the publisher)', () => {
    class Entity {
      title = 'x';
      tags = ['a'];
    }
    const entity = new Entity();
    const when = new Date(0);
    const map = new Map([['k', 1]]);
    const payload = { entity, when, map, plain: { n: 1 } };
    deepFreeze(payload);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.plain)).toBe(true);
    entity.title = 'changed';
    entity.tags.push('b');
    expect(entity).toEqual(Object.assign(new Entity(), { title: 'changed', tags: ['a', 'b'] }));
    expect(Object.isFrozen(when)).toBe(false);
    map.set('k', 2);
    expect(map.get('k')).toBe(2);
  });

  test('deepFreeze handles cycles and skips typed arrays', () => {
    const value: Record<string, unknown> = { bytes: new Uint8Array(4), list: [{ n: 1 }] };
    value.self = value;
    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen((value.list as object[])[0])).toBe(true);
    expect(Object.isFrozen(value.bytes)).toBe(false);
  });
});
