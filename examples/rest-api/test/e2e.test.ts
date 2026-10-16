import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SchedulerRegistry } from '@knead-js/schedule';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import { AppModule } from '../src/app.module.js';
import { UsersStats } from '../src/users/users.stats.js';

let mod: TestingModule;
let app: TestApp;
const admin = { authorization: 'Bearer admin-token' };
const origin = { origin: 'http://localhost:5173' };

beforeAll(async () => {
  mod = await Test.createModule({ imports: [AppModule] }).compile({ development: false });
  app = await mod.createApp();
});
afterAll(async () => {
  await mod.close();
});

describe('example REST API', () => {
  test('the hourly users report is scheduled and can be triggered', async () => {
    const registry = mod.get(SchedulerRegistry);
    const job = registry.get('users.hourly-stats');
    expect(job?.state).toBe('scheduled');
    expect(job?.nextRunAt?.getMinutes()).toBe(0);
    await registry.trigger('users.hourly-stats');
    expect(mod.get(UsersStats).lastCount).toBe(1);
    expect(mod.logs.some((e) => e.level === 'info' && e.message === '1 users')).toBe(true);
  });

  test('lists users with security, CORS and rate-limit headers', async () => {
    const res = await app.request('GET', '/users', { headers: origin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: '1', name: 'Ada', bio: '' }]);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('ratelimit-limit')).toBe('100');
  });

  test('creating requires a token and the admin role', async () => {
    const missing = await app.request('POST', '/users', {
      json: { name: 'Grace' },
      headers: origin,
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(missing.headers.get('content-security-policy')).toContain("default-src 'self'");
    const forbidden = await app.request('POST', '/users', {
      json: { name: 'Grace' },
      headers: { authorization: 'Bearer user-token' },
    });
    expect(forbidden.status).toBe(403);
  });

  test('admins create users; names are trimmed and bios sanitized', async () => {
    const res = await app.request('POST', '/users', {
      json: {
        name: '  Grace ',
        bio: '<b>hi</b><script>alert(1)</script><img src=x onerror=alert(1)>',
      },
      headers: admin,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: '2', name: 'Grace', bio: '<b>hi</b>' });
  });

  test('invalid bodies are 400 problem+json with issues', async () => {
    const res = await app.request('POST', '/users', { json: { name: '' }, headers: admin });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { title: string; issues: unknown[] };
    expect(problem.title).toBe('Bad Request');
    expect(problem.issues[0]).toMatchObject({ source: 'body', path: ['name'] });
  });

  test('delete then 404', async () => {
    expect((await app.request('DELETE', '/users/2', { headers: admin })).status).toBe(204);
    const gone = await app.request('GET', '/users/2');
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { detail: string }).detail).toBe('User 2 not found');
  });
});
