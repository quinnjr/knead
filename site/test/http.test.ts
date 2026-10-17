import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { ModuleOptions } from '@knead-js/core';
import {
  BadRequestException,
  ConflictException,
  ConsoleLogger,
  Controller,
  type Ctx,
  checkBunVersion,
  compareVersions,
  DEFAULT_MAX_PARAMS,
  ForbiddenException,
  Get,
  HttpConfigError,
  HttpException,
  InternalServerErrorException,
  type ListenOptions,
  MemoryLogger,
  MethodNotAllowedException,
  MIN_BUN_VERSION,
  type MiddlewareFn,
  NotFoundException,
  Post,
  problemResponse,
  redirectToHttps,
  requestUrl,
  ServiceUnavailableException,
  STATUS_TITLES,
  TooManyRequestsException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  UseMiddleware,
  ValidationException,
  withHeaders,
} from '@knead-js/http';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import {
  AssetsController,
  CatsModule,
  MethodsController,
  OwnersController,
} from '../snippets/http/controllers.js';
import { NoStoreErrorsFilter } from '../snippets/http/default-error-response.js';
import {
  CheckoutController,
  InventoryClient,
  PaymentRequiredException,
} from '../snippets/http/errors.js';
import { pathOf } from '../snippets/http/reference.js';
import { InspectController, NotesController } from '../snippets/http/request-context.js';
import { OrdersController, ResponsesController } from '../snippets/http/responses.js';
import { ConflictingNamesModule, DuplicateRouteModule } from '../snippets/http/route-conflicts.js';
import { ReportsController } from '../snippets/http/route-meta.js';
import {
  BooksController,
  InvitesController,
  VersionedController,
} from '../snippets/http/validation.js';

interface Started {
  module: TestingModule;
  app: TestApp;
  logs: MemoryLogger;
}

async function start(
  metadata: ModuleOptions,
  options: { development?: boolean; listen?: ListenOptions } = {},
): Promise<Started> {
  const logs = new MemoryLogger();
  const module = await Test.createModule(metadata).compile({
    development: options.development ?? false,
    logger: logs,
  });
  const app = await module.createApp(options.listen);
  return { module, app, logs };
}

/** One server for a describe block, closed after it. */
function serve(metadata: ModuleOptions, options?: Parameters<typeof start>[1]) {
  const ref = {} as Started;
  beforeAll(async () => Object.assign(ref, await start(metadata, options)));
  afterAll(() => ref.module.close());
  return ref;
}

const PROBLEM = 'application/problem+json; charset=utf-8';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('http: controllers', () => {
  const s = serve({
    imports: [CatsModule],
    controllers: [MethodsController, OwnersController, AssetsController],
  });

  test('routes join the prefix and the path, and return JSON', async () => {
    const res = await s.app.request('GET', '/cats');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual([{ id: '1', name: 'Tom' }]);
    expect(await (await s.app.request('GET', '/cats/1')).json()).toEqual({ id: '1', name: 'Tom' });
  });

  test('a thrown NotFoundException is a 404 problem', async () => {
    const res = await s.app.request('GET', '/cats/9');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe(PROBLEM);
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Cat 9 not found',
      instance: '/cats/9',
    });
  });

  test('a handler returning undefined is a 204', async () => {
    const res = await s.app.request('DELETE', '/cats/1');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  test('trailing slashes are strict', async () => {
    const res = await s.app.request('GET', '/cats/1/');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('No route for GET /cats/1/');
  });

  test('a known path with another method is a 405 with Allow', async () => {
    const res = await s.app.request('PUT', '/cats/1');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, DELETE, HEAD');
    expect(((await res.json()) as { detail: string }).detail).toBe('PUT is not allowed on /cats/1');
  });

  test('HEAD is answered by the GET route, without a body', async () => {
    const res = await s.app.request('HEAD', '/cats');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  test('every method decorator', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const path = `/methods/${method === 'DELETE' ? 'delete' : method.toLowerCase()}`;
      expect(await (await s.app.request(method, path)).text()).toBe(method);
      expect(await (await s.app.request(method, '/methods/all')).text()).toBe(method);
    }
    const head = await s.app.request('HEAD', '/methods/head');
    expect(head.status).toBe(204);
    expect(head.headers.get('x-head')).toBe('yes');
    expect((await s.app.request('HEAD', '/methods/all')).status).toBe(200);
  });

  test('params are decoded strings; exact paths win over parameters', async () => {
    const res = await s.app.request('GET', '/owners/a%20b/cats/7');
    expect(await res.json()).toEqual({ owner: 'a b', cat: '7' });
    expect(await (await s.app.request('GET', '/owners/me')).json()).toEqual({ owner: 'me' });
  });

  test('a trailing wildcard matches the rest of the path, including nothing', async () => {
    const res = await s.app.request('GET', '/assets/css/site.css');
    expect(await res.json()).toEqual({ path: 'css/site.css' });
    expect(await (await s.app.request('GET', '/assets/')).json()).toEqual({ path: '' });
    expect((await s.app.request('GET', '/assets')).status).toBe(404);
  });

  test('the most specific route wins, whatever the declaration order', async () => {
    @Controller('api/')
    class SpecificityController {
      @Get('/*') rest() {
        return 'wildcard';
      }
      @Get('//w/:id/') param() {
        return 'param';
      }
      @Get('/w/x') exact() {
        return 'exact';
      }
    }
    const t = await start({ controllers: [SpecificityController] });
    try {
      expect(await (await t.app.request('GET', '/api/w/x')).text()).toBe('exact');
      expect(await (await t.app.request('GET', '/api/w/5')).text()).toBe('param');
      expect(await (await t.app.request('GET', '/api/w/5/6')).text()).toBe('wildcard');
      expect(t.module.app.routes.map((r) => r.path)).toEqual(['/api/*', '/api/w/:id', '/api/w/x']);
    } finally {
      await t.module.close();
    }
  });

  test('the route table', () => {
    const table = s.module.app.routes.map((r) => `${r.method} ${r.path} ${r.handler}`);
    expect(table).toContain('GET /cats CatsController.list');
    expect(table).toContain('GET /cats/:id CatsController.find');
    expect(table).toContain('DELETE /cats/:id CatsController.remove');
    expect(table.filter((r) => r.includes('/methods/all'))).toHaveLength(6);
  });
});

describe('http: route definition errors', () => {
  async function listenError(metadata: ModuleOptions): Promise<unknown> {
    const module = await Test.createModule(metadata).compile({ logger: new MemoryLogger() });
    try {
      await module.createApp();
      return undefined;
    } catch (error) {
      return error;
    } finally {
      await module.close();
    }
  }

  test('parameter names must match', async () => {
    const error = await listenError({ imports: [ConflictingNamesModule] });
    expect(error).toBeInstanceOf(HttpConfigError);
    expect((error as Error).message).toBe(
      'Routes /users/:id and /users/:userId differ only in parameter names; use the same names (UsersController.remove).',
    );
  });

  test('duplicate routes', async () => {
    const error = await listenError({ imports: [DuplicateRouteModule] });
    expect(error).toBeInstanceOf(HttpConfigError);
    expect((error as Error).message).toBe(
      'Duplicate route GET /health: HealthController.check and StatusController.status.',
    );
  });

  test('more than one wildcard', async () => {
    @Controller('/files')
    class FilesController {
      @Get('/*/x/*') files() {}
    }
    const error = await listenError({ controllers: [FilesController] });
    expect((error as Error).message).toBe(
      'Route /files/*/x/* has more than one "*" wildcard (FilesController.files).',
    );
  });

  test('a wildcard that is not the last segment', async () => {
    @Controller('/a')
    class MiddleController {
      @Get('/*/b') middle() {}
    }
    const error = await listenError({ controllers: [MiddleController] });
    expect((error as Error).message).toBe(
      'Route /a/*/b has a "*" that is not the whole last segment (MiddleController.middle); Bun only matches a trailing "/*".',
    );
  });

  test('a controller without @Controller', async () => {
    class PlainController {}
    const error = await listenError({ controllers: [PlainController] });
    expect((error as Error).message).toBe(
      'PlainController is listed in TestRootModule.controllers but is not decorated with @Controller().',
    );
  });

  test('static methods cannot be routes', () => {
    expect(() => {
      class Bad {
        @Get('/') static list() {}
      }
      return Bad;
    }).toThrow('@Get() cannot decorate static or private method list.');
  });
});

describe('http: responses', () => {
  const s = serve({ controllers: [ResponsesController, OrdersController, ReportsController] });

  test('values map to responses, with nosniff on built responses', async () => {
    const json = await s.app.request('GET', '/demo/json');
    expect(json.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await json.json()).toEqual({ ok: true });

    const text = await s.app.request('GET', '/demo/text');
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await text.text()).toBe('pong');

    const nothing = await s.app.request('GET', '/demo/nothing');
    expect(nothing.status).toBe(204);
    expect(nothing.headers.get('x-content-type-options')).toBe('nosniff');

    const bytes = await s.app.request('GET', '/demo/bytes');
    expect(bytes.headers.get('content-type')).toBe('application/octet-stream');
    expect(await bytes.text()).toBe('raw');

    const blob = await s.app.request('GET', '/demo/blob');
    expect(blob.headers.get('content-type')).toBe('image/svg+xml');
  });

  test('a returned Response is sent as is', async () => {
    const res = await fetch(new URL('/demo/redirect', s.app.url), { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/');
    expect(res.headers.get('x-content-type-options')).toBeNull();
  });

  test('the status option, ctx.res.status and ctx.res.headers', async () => {
    expect((await s.app.request('POST', '/orders')).status).toBe(201);
    const found = await s.app.request('GET', '/orders/o_1');
    expect(found.status).toBe(200);
    expect(found.headers.get('cache-control')).toBe('private, max-age=60');
    expect((await s.app.request('GET', '/orders/legacy')).status).toBe(203);
  });

  test('route metadata merges controller and route levels', async () => {
    expect(await (await s.app.request('GET', '/reports/daily')).json()).toEqual({
      audit: true,
      roles: ['staff'],
    });
    expect(await (await s.app.request('GET', '/reports/payroll')).json()).toEqual({
      audit: 'strict',
      roles: ['finance'],
    });
  });

  test('a value that cannot be serialized is a 500', async () => {
    @Controller('/odd')
    class OddController {
      @Get('/') odd() {
        return { n: 1n };
      }
    }
    const t = await start({ controllers: [OddController] });
    try {
      expect((await t.app.request('GET', '/odd')).status).toBe(500);
    } finally {
      await t.module.close();
    }
  });
});

describe('http: request context', () => {
  const s = serve({ controllers: [InspectController, NotesController] });

  test('params, query, headers, state and route', async () => {
    const res = await s.app.request('GET', '/inspect/42', {
      query: { tag: ['a', 'b'] },
      headers: { 'User-Agent': 'docs-test', 'X-Tenant': 'acme' },
    });
    expect(await res.json()).toEqual({
      id: '42',
      tags: ['a', 'b'],
      agent: 'docs-test',
      tenant: 'acme',
      route: '/inspect/:id',
    });
    const single = await s.app.request('GET', '/inspect/1', { query: { tag: 'a' } });
    expect(((await single.json()) as { tags: unknown; tenant: string }).tags).toBe('a');
  });

  const post = (body: string, type?: string) =>
    s.app.request('POST', '/notes', {
      body,
      headers: type === undefined ? {} : { 'content-type': type },
    });

  test('ctx.json() parses JSON, forms and text', async () => {
    expect(await (await post('{"text":"hi"}', 'application/json')).json()).toEqual({
      received: 'hi',
    });
    expect(await (await post('{"text":"hi"}', 'application/merge-patch+json')).json()).toEqual({
      received: 'hi',
    });
    expect(await (await post('text=hi', 'application/x-www-form-urlencoded')).json()).toEqual({
      received: 'hi',
    });
    const form = new FormData();
    form.append('text', 'hi');
    const multipart = await s.app.request('POST', '/notes', { body: form });
    expect(await multipart.json()).toEqual({ received: 'hi' });
    expect(await (await post('', 'application/json')).json()).toEqual({ received: null });
  });

  test('body errors', async () => {
    const malformed = await post('{nope', 'application/json');
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { detail: string }).detail).toBe('Malformed JSON body');
    const xml = await post('<note/>', 'application/xml');
    expect(xml.status).toBe(415);
    expect(((await xml.json()) as { detail: string }).detail).toBe(
      'Unsupported content type: application/xml',
    );
  });

  test('a body without a Content-Type is a 415', async () => {
    const res = await fetch(
      new Request(new URL('/notes', s.app.url).href, { method: 'POST', body: new Uint8Array([1]) }),
    );
    expect(res.status).toBe(415);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      'Unsupported content type: (none)',
    );
  });

  test('unsafe keys are dropped from JSON bodies and queries', async () => {
    @Controller('/echo')
    class EchoController {
      @Get('/') query(ctx: Ctx) {
        return {
          keys: Object.keys(ctx.query),
          nullProto: Object.getPrototypeOf(ctx.query) === null,
        };
      }
      @Post('/') async body(ctx: Ctx) {
        const body = (await ctx.json()) as Record<string, Record<string, unknown>>;
        return { keys: Object.keys(body), profile: Object.keys(body.profile ?? {}) };
      }
    }
    const t = await start({ controllers: [EchoController] });
    try {
      const query = await t.app.request('GET', '/echo?a=1&__proto__=x&constructor=y&prototype=z');
      expect(await query.json()).toEqual({ keys: ['a'], nullProto: true });
      const body = await t.app.request('POST', '/echo', {
        body: '{"__proto__":{"admin":true},"profile":{"constructor":{"x":1},"name":"a"},"constructor":"kept"}',
        headers: { 'content-type': 'application/json' },
      });
      expect(await body.json()).toEqual({ keys: ['profile', 'constructor'], profile: ['name'] });
      const escaped = await t.app.request('POST', '/echo', {
        body: '{"\\u005f_proto__":{"admin":true},"profile":{}}',
        headers: { 'content-type': 'application/json' },
      });
      expect(await escaped.json()).toEqual({ keys: ['profile'], profile: [] });
    } finally {
      await t.module.close();
    }
  });

  test('a body read outside ctx.json() cannot be parsed again', async () => {
    const readsBody: MiddlewareFn = async (ctx, next) => {
      await ctx.req.text();
      return next();
    };
    @Controller('/twice')
    @UseMiddleware(readsBody)
    class TwiceController {
      @Post('/') async post(ctx: Ctx) {
        return { body: await ctx.json() };
      }
    }
    const t = await start({ controllers: [TwiceController] });
    try {
      const res = await t.app.request('POST', '/twice', { json: { a: 1 } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { detail: string }).detail).toBe('Failed to read request body');
    } finally {
      await t.module.close();
    }
  });

  test('the response draft does not apply to error responses', async () => {
    @Controller('/draft')
    class DraftController {
      @Get('/') fail(ctx: Ctx) {
        ctx.res.status = 202;
        ctx.res.headers.set('x-draft', '1');
        throw new BadRequestException('no', { headers: { 'retry-after': '5' } });
      }
      @Get('/headers') headers(ctx: Ctx) {
        return { a: ctx.headers['x-a'], nullProto: Object.getPrototypeOf(ctx.headers) === null };
      }
    }
    const t = await start({ controllers: [DraftController] });
    try {
      const res = await t.app.request('GET', '/draft');
      expect(res.status).toBe(400);
      expect(res.headers.get('x-draft')).toBeNull();
      expect(res.headers.get('retry-after')).toBe('5');
      const headers = await t.app.request('GET', '/draft/headers', {
        headers: [
          ['X-A', '1'],
          ['x-a', '2'],
        ],
      });
      expect(await headers.json()).toEqual({ a: '1, 2', nullProto: true });
    } finally {
      await t.module.close();
    }
  });

  test('requestUrl never throws', () => {
    expect(pathOf(new Request('http://localhost/a/b?c=1'))).toBe('/a/b');
    expect(requestUrl(new Request('http://localhost/x')).origin).toBe('http://localhost');
  });
});

describe('http: request limits', () => {
  @Controller('/limits')
  class LimitsController {
    @Get('/') query(ctx: Ctx) {
      return ctx.query;
    }
  }
  const s = serve(
    { controllers: [LimitsController, NotesController] },
    { listen: { maxParams: 2, maxRequestBodySize: 64 } },
  );

  test('the default is 1000 parameters', () => {
    expect(DEFAULT_MAX_PARAMS).toBe(1000);
  });

  test('too many query parameters is a 400', async () => {
    expect((await s.app.request('GET', '/limits?a=1&b=2')).status).toBe(200);
    const res = await s.app.request('GET', '/limits?a=1&b=2&c=3');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      'The query string has more than 2 parameters.',
    );
  });

  test('too many form fields is a 413', async () => {
    const res = await s.app.request('POST', '/notes', {
      body: 'a=1&b=2&c=3',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Content Too Large',
      status: 413,
      detail: 'The request body has more than 2 fields.',
      instance: '/notes',
    });
  });

  test('a body over maxRequestBodySize is a 413 from Bun, with no body', async () => {
    const res = await s.app.request('POST', '/notes', {
      body: JSON.stringify({ text: 'x'.repeat(100) }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(413);
    expect(await res.text()).toBe('');
  });

  test('maxParams must be a positive integer', async () => {
    const module = await Test.createModule({}).compile({ logger: new MemoryLogger() });
    try {
      await expect(module.createApp({ maxParams: 0 })).rejects.toThrow(
        'maxParams must be an integer >= 1, got 0.',
      );
    } finally {
      await module.close();
    }
  });
});

describe('http: validation', () => {
  const s = serve({ controllers: [BooksController, VersionedController, InvitesController] });

  test('schema output replaces params, query and body', async () => {
    expect(await (await s.app.request('GET', '/books/12')).json()).toEqual({
      id: 12,
      fields: 'summary',
    });
    const created = await s.app.request('POST', '/books', {
      json: { title: '  Dune ', year: 1965, draft: true },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ title: 'Dune', year: 1965 });
  });

  test('issues from every source are collected into one 400', async () => {
    const res = await s.app.request('GET', '/books/abc?fields=all');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe(PROBLEM);
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'Request validation failed',
      instance: '/books/abc',
      issues: [
        { source: 'params', message: 'id must be numeric', path: ['id'] },
        { source: 'query', message: 'fields must be summary or full', path: ['fields'] },
      ],
    });
  });

  test('body issues', async () => {
    const res = await s.app.request('POST', '/books', { json: { title: '', year: 1.5 } });
    expect(((await res.json()) as { issues: unknown }).issues).toEqual([
      { source: 'body', message: 'title is empty', path: ['title'] },
      { source: 'body', message: 'year must be an integer', path: ['year'] },
    ]);
    const missing = await s.app.request('POST', '/books', { json: {} });
    expect(((await missing.json()) as { issues: unknown }).issues).toEqual([
      {
        source: 'body',
        message: 'Invalid key: Expected "title" but received undefined',
        path: ['title'],
      },
      {
        source: 'body',
        message: 'Invalid key: Expected "year" but received undefined',
        path: ['year'],
      },
    ]);
  });

  test('a malformed body is a plain 400, not a validation issue', async () => {
    const res = await s.app.request('POST', '/books', {
      body: '{',
      headers: { 'content-type': 'application/json' },
    });
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'Malformed JSON body',
      instance: '/books',
    });
  });

  test('header issue messages are always generic', async () => {
    const res = await s.app.request('GET', '/versioned', { headers: { 'x-api-version': '3' } });
    expect(((await res.json()) as { issues: unknown }).issues).toEqual([
      { source: 'headers', message: 'Invalid header value', path: ['x-api-version'] },
    ]);
    const ok = await s.app.request('GET', '/versioned', { headers: { 'x-api-version': '2' } });
    expect(await ok.json()).toEqual({ version: '2' });
  });

  test('authorize guards see the validated body', async () => {
    const ok = await s.app.request('POST', '/invites', { json: { email: ' Ada@Example.com ' } });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ invited: 'ada@example.com' });
    const denied = await s.app.request('POST', '/invites', { json: { email: 'ada@other.org' } });
    expect(denied.status).toBe(403);
  });

  test('redactIssueMessages', async () => {
    const t = await start(
      { controllers: [BooksController] },
      { listen: { validation: { redactIssueMessages: true } } },
    );
    try {
      const res = await t.app.request('GET', '/books/abc');
      expect(((await res.json()) as { issues: unknown }).issues).toEqual([
        { source: 'params', message: 'Invalid value', path: ['id'] },
      ]);
    } finally {
      await t.module.close();
    }
  });

  test('ValidationException', () => {
    const error = new ValidationException([{ source: 'body', message: 'bad', path: ['a'] }]);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.toProblem('/x')).toEqual({
      issues: [{ source: 'body', message: 'bad', path: ['a'] }],
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'Request validation failed',
      instance: '/x',
    });
  });
});

describe('http: errors in production', () => {
  const inventory = { provide: InventoryClient, useClass: InventoryClient };
  const s = serve({ controllers: [CheckoutController], providers: [inventory] });

  test('4xx problems keep detail, type and extensions', async () => {
    const res = await s.app.request('POST', '/checkout/sold-out');
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toBe(PROBLEM);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.json()).toEqual({
      sku: 'sold-out',
      type: 'https://example.com/problems/sold-out',
      title: 'Conflict',
      status: 409,
      detail: 'SKU sold-out is sold out',
      instance: '/checkout/sold-out',
    });
    expect(await (await s.app.request('POST', '/checkout/unpaid')).json()).toEqual({
      type: 'about:blank',
      title: 'Payment Required',
      status: 402,
      detail: 'Settle your balance first',
      instance: '/checkout/unpaid',
    });
  });

  test('5xx problems drop detail and extensions, keep headers and add a correlation id', async () => {
    s.logs.clear();
    const res = await s.app.request('POST', '/checkout/widget');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['type', 'title', 'status', 'instance', 'correlationId']);
    expect(body).toMatchObject({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      instance: '/checkout/widget',
    });
    expect(body.correlationId).toMatch(UUID);
    const [warn, error] = s.logs.entries;
    expect(warn?.level).toBe('warn');
    expect(warn?.message).toMatch(
      /^Reserving widget failed \(correlation id [0-9a-f-]{36}\): Error: connect ECONNREFUSED postgres:\/\/\*\*\*@10\.0\.0\.5:5432\/inventory$/,
    );
    expect(error?.level).toBe('error');
    expect(error?.message).toBe(
      `503 on POST /checkout/widget (correlation id ${body.correlationId}): ServiceUnavailableException: Inventory is unavailable`,
    );
  });

  test('unknown errors are a bare 500, logged as Name: message', async () => {
    s.logs.clear();
    const res = await s.app.request('GET', '/checkout/crash');
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['type', 'title', 'status', 'instance', 'correlationId']);
    expect(body.title).toBe('Internal Server Error');
    expect(s.logs.entries).toEqual([
      {
        level: 'error',
        message: `Unhandled error on GET /checkout/crash (correlation id ${body.correlationId}): Error: Lost connection to redis://***@cache:6379`,
        meta: [],
      },
    ]);
  });
});

describe('http: error log lines with ConsoleLogger', () => {
  test('the default logger prints the summary line', async () => {
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const module = await Test.createModule({
      controllers: [CheckoutController],
      providers: [InventoryClient],
    }).compile({ logger: new ConsoleLogger(), development: false });
    try {
      const app = await module.createApp();
      const res = await app.request('GET', '/checkout/crash');
      const { correlationId } = (await res.json()) as { correlationId: string };
      expect(lines).toEqual([
        `[knead] Unhandled error on GET /checkout/crash (correlation id ${correlationId}): Error: Lost connection to redis://***@cache:6379`,
      ]);
    } finally {
      spy.mockRestore();
      await module.close();
    }
  });
});

describe('http: errors in development', () => {
  const s = serve(
    { controllers: [CheckoutController], providers: [InventoryClient] },
    { development: true },
  );

  test('5xx HttpExceptions keep detail and extensions', async () => {
    const res = await s.app.request('POST', '/checkout/widget');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.detail).toBe('Inventory is unavailable');
    expect(body.correlationId).toMatch(UUID);
  });

  test('unknown errors include the redacted message and stack', async () => {
    s.logs.clear();
    const res = await s.app.request('GET', '/checkout/crash');
    const body = (await res.json()) as { detail: string; stack: string; correlationId: string };
    expect(body.detail).toBe('Lost connection to redis://***@cache:6379');
    expect(body.stack).toStartWith('Error: Lost connection to redis://***@cache:6379');
    expect(body.stack).not.toContain('s3cret');
    const [entry] = s.logs.entries;
    expect(entry?.message).toBe(
      `Unhandled error on GET /checkout/crash (correlation id ${body.correlationId})`,
    );
    expect(entry?.meta).toHaveLength(1);
  });
});

describe('http: defaultErrorResponse in a filter', () => {
  @Controller('/broken')
  class BrokenController {
    @Get('/') broken() {
      throw new ForbiddenException('No access');
    }
  }

  test('wraps the default problem response', async () => {
    const module = await Test.createModule({ controllers: [BrokenController] }).compile({
      logger: new MemoryLogger(),
      development: false,
    });
    module.app.useGlobalFilters(NoStoreErrorsFilter);
    try {
      const app = await module.createApp();
      const res = await app.request('GET', '/broken');
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'No access',
        instance: '/broken',
      });
    } finally {
      await module.close();
    }
  });
});

describe('http: exception classes', () => {
  test('subclasses, titles and statuses', () => {
    const cases: [HttpException, number, string][] = [
      [new BadRequestException(), 400, 'Bad Request'],
      [new UnauthorizedException(), 401, 'Unauthorized'],
      [new ForbiddenException(), 403, 'Forbidden'],
      [new NotFoundException(), 404, 'Not Found'],
      [new MethodNotAllowedException(), 405, 'Method Not Allowed'],
      [new ConflictException(), 409, 'Conflict'],
      [new UnsupportedMediaTypeException(), 415, 'Unsupported Media Type'],
      [new UnprocessableEntityException(), 422, 'Unprocessable Content'],
      [new TooManyRequestsException(), 429, 'Too Many Requests'],
      [new InternalServerErrorException(), 500, 'Internal Server Error'],
      [new ServiceUnavailableException(), 503, 'Service Unavailable'],
    ];
    for (const [error, status, title] of cases) {
      expect(error.status).toBe(status);
      expect(error.title).toBe(title);
      expect(error.message).toBe(title);
      expect(error.detail).toBeUndefined();
      expect(error.type).toBe('about:blank');
    }
    expect(STATUS_TITLES[413]).toBe('Content Too Large');
    expect(STATUS_TITLES[421]).toBe('Misdirected Request');
  });

  test('name, message, unknown titles and the status range', () => {
    const error = new PaymentRequiredException('Pay');
    expect(error.name).toBe('PaymentRequiredException');
    expect(error.message).toBe('Pay');
    expect(new HttpException(418).title).toBe('Error');
    expect(() => new HttpException(302)).toThrow(
      'HttpException status must be an integer between 400 and 599, got 302',
    );
  });

  test('extensions cannot override reserved members', () => {
    const error = new HttpException(400, 'x', { extensions: { status: 200, hint: 'h' } });
    expect(error.toProblem()).toEqual({
      hint: 'h',
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'x',
    });
  });

  test('an extension named detail stays only when there is no detail', () => {
    expect(new HttpException(400, undefined, { extensions: { detail: 'd' } }).toProblem()).toEqual({
      detail: 'd',
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
    });
    const problem = new HttpException(400, 'real', { extensions: { detail: 'd' } }).toProblem('/p');
    expect(problem.detail).toBe('real');
    expect(problem.instance).toBe('/p');
  });

  test('problemResponse', async () => {
    const res = problemResponse({ type: 'about:blank', title: 'Gone', status: 410 });
    expect(res.status).toBe(410);
    expect(res.headers.get('content-type')).toBe(PROBLEM);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('http: helpers', () => {
  test('withHeaders', () => {
    const res = withHeaders(new Response('x', { headers: { a: '1' } }), { a: '2', b: '3' }, false);
    expect(res.headers.get('a')).toBe('1');
    expect(res.headers.get('b')).toBe('3');
    const redirect = withHeaders(Response.redirect('https://example.com/'), { 'x-a': '1' });
    expect(redirect.headers.get('x-a')).toBe('1');
    expect(redirect.status).toBe(302);
  });

  test('redirectToHttps', () => {
    const req = new Request('http://example.com/a?b=1', { headers: { host: 'example.com:80' } });
    const res = redirectToHttps(req, 8443);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://example.com:8443/a?b=1');
    expect(redirectToHttps(req, 443, 'www.example.com').headers.get('location')).toBe(
      'https://www.example.com/a?b=1',
    );
  });

  test('versions', () => {
    expect(MIN_BUN_VERSION).toBe('1.4.3');
    expect(compareVersions('1.4.3', '1.4.10')).toBeLessThan(0);
    expect(compareVersions('1.5.0-canary.1', '1.5.0')).toBe(0);
    const logs = new MemoryLogger();
    expect(checkBunVersion(logs, '1.5.0')).toBe(true);
    expect(logs.entries).toEqual([]);
  });
});
