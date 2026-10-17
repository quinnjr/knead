import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import { TodosModule } from './todos.module.js';

let moduleRef: TestingModule;
let app: TestApp;

beforeEach(async () => {
  moduleRef = await Test.createModule({ imports: [TodosModule] }).compile();
  app = await moduleRef.createApp();
});

afterEach(() => moduleRef.close());

test('creates and reads a todo', async () => {
  const created = await app.request('POST', '/todos', { json: { title: '  Buy flour ' } });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ id: 1, title: 'Buy flour', done: false });

  const read = await app.request('GET', '/todos/1');
  expect(await read.json()).toEqual({ id: 1, title: 'Buy flour', done: false });
});

test('rejects an empty title', async () => {
  const res = await app.request('POST', '/todos', { json: { title: '' } });
  expect(res.status).toBe(400);
});
