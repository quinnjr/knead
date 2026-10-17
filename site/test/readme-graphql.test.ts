import { afterEach, expect, spyOn, test } from 'bun:test';
import { Test, type TestingModule } from '@knead-js/testing';
import { AppModule, AuthorsById } from '../snippets/readme/graphql.js';

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

test('README quick start: queries resolve, and authors load in one batch', async () => {
  mod = await Test.createModule({ imports: [AppModule] }).compile({ development: false });
  const app = await mod.createApp();
  const batch = spyOn(mod.get(AuthorsById), 'batch');

  const res = await app.graphql('{ books { title subtitle author { name } } }');
  expect(res.errors).toBeUndefined();
  expect(res.data).toEqual({
    books: [
      { title: 'Kindred', subtitle: null, author: { name: 'Octavia E. Butler' } },
      { title: 'Parable of the Sower', subtitle: null, author: { name: 'Octavia E. Butler' } },
    ],
  });
  expect(batch).toHaveBeenCalledTimes(1);

  const one = await app.graphql('query ($id: ID!) { book(id: $id) { title } }', {
    variables: { id: 'b2' },
  });
  expect(one.data).toEqual({ book: { title: 'Parable of the Sower' } });
});
