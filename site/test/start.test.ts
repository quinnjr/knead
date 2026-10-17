// Pins the responses shown on guide/getting-started.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import { AppModule } from '../snippets/start/app.module.js';

describe('getting started', () => {
  let moduleRef: TestingModule;
  let app: TestApp;

  beforeAll(async () => {
    // Production mode: what `bun main.ts` runs without NODE_ENV=development.
    moduleRef = await Test.createModule({ imports: [AppModule] }).compile({ development: false });
    app = await moduleRef.createApp();
  });

  afterAll(() => moduleRef.close());

  test('POST /todos creates a todo with 201', async () => {
    const res = await app.request('POST', '/todos', { json: { title: 'Buy flour' } });
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.text()).toBe('{"id":1,"title":"Buy flour","done":false}');
  });

  test('GET /todos lists todos', async () => {
    const res = await app.request('GET', '/todos');
    expect(await res.text()).toBe('[{"id":1,"title":"Buy flour","done":false}]');
  });

  test('an invalid body is a 400 problem response', async () => {
    const res = await app.request('POST', '/todos', { json: { title: '' } });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(await res.json()).toEqual({
      issues: [
        { source: 'body', message: 'Invalid length: Expected >=1 but received 0', path: ['title'] },
      ],
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'Request validation failed',
      instance: '/todos',
    });
  });

  test('an unknown id is a 404 problem response', async () => {
    const res = await app.request('GET', '/todos/7');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Todo 7 does not exist',
      instance: '/todos/7',
    });
  });

  test('a non-numeric id fails params validation', async () => {
    const res = await app.request('GET', '/todos/abc');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: unknown }).issues).toEqual([
      { source: 'params', message: 'Invalid digits: Received "abc"', path: ['id'] },
    ]);
  });

  test('DELETE returns 204 with no body', async () => {
    const res = await app.request('DELETE', '/todos/1');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });
});
