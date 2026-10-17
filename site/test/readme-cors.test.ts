import { afterEach, expect, test } from 'bun:test';
import { Test, type TestingModule } from '@knead-js/testing';
import { AppModule } from '../snippets/readme/cors.js';

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

test('README quick start: listed origins get CORS headers, others do not', async () => {
  mod = await Test.createModule({ imports: [AppModule] }).compile();
  const app = await mod.createApp();

  const allowed = await app.request('GET', '/api/projects', {
    headers: { origin: 'https://admin.example.com' },
  });
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get('access-control-allow-origin')).toBe('https://admin.example.com');
  expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
  expect(allowed.headers.get('vary')).toBe('Origin');

  const other = await app.request('GET', '/api/projects', {
    headers: { origin: 'https://evil.example' },
  });
  expect(other.status).toBe(200);
  expect(other.headers.get('access-control-allow-origin')).toBeNull();

  const preflight = await app.request('OPTIONS', '/api/projects', {
    headers: {
      origin: 'https://app.example.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-methods')).toBe(
    'GET, HEAD, PUT, PATCH, POST, DELETE',
  );
  expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type');
  expect(preflight.headers.get('access-control-max-age')).toBe('600');
});
