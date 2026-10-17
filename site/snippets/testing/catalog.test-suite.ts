import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryLogger } from '@knead-js/http';
import { Test, type TestingModule } from '@knead-js/testing';
import {
  AdminGuard,
  CatalogModule,
  type Product,
  ProductsService,
  RequestIdMiddleware,
  StorageError,
  StorageErrorFilter,
} from './catalog.js';

// #region doubles
/** A store whose lookups fail, for testing error paths. */
class FailingProducts extends ProductsService {
  override find(): Product | undefined {
    throw new Error('disk on fire');
  }
}

/** A store that is unreachable. */
class UnavailableProducts extends ProductsService {
  override list(): Product[] {
    throw new StorageError('replica lag');
  }
}
// #endregion doubles

// #region lifecycle
let mod: TestingModule | undefined;

afterEach(async () => {
  // Stops the server (if one was started) and runs the shutdown hooks.
  await mod?.close();
  mod = undefined;
});
// #endregion lifecycle

describe('ProductsService', () => {
  // #region get
  test('finds a product by id', async () => {
    mod = await Test.createModule({ imports: [CatalogModule] }).compile();

    expect(mod.get(ProductsService).find('p1')?.name).toBe('Kettle');
  });
  // #endregion get
});

describe('GET /products', () => {
  // #region request
  test('filters by tag and echoes the request id', async () => {
    mod = await Test.createModule({ imports: [CatalogModule] }).compile();
    const app = await mod.createApp();

    const res = await app.request('GET', '/products', {
      query: { tag: ['office', 'garden'] },
      headers: { 'x-request-id': 'req-42' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('req-42');
    expect(((await res.json()) as Product[]).map((p) => p.id)).toEqual(['p2']);
  });
  // #endregion request

  // #region not-found
  test('answers an unknown id with a 404 problem', async () => {
    mod = await Test.createModule({ imports: [CatalogModule] }).compile();
    const app = await mod.createApp();

    const res = await app.request('GET', '/products/p9');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No product p9',
      instance: '/products/p9',
    });
  });
  // #endregion not-found
});

describe('POST /products', () => {
  // #region guard
  test('rejects requests without the admin key', async () => {
    mod = await Test.createModule({ imports: [CatalogModule] }).compile();
    const app = await mod.createApp();

    const res = await app.request('POST', '/products', { json: { name: 'Mug' } });

    expect(res.status).toBe(403);
  });

  test('creates a product when the guard allows it', async () => {
    mod = await Test.createModule({ imports: [CatalogModule] })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = await mod.createApp();

    const res = await app.request('POST', '/products', {
      json: { name: 'Mug', priceCents: 1200, tags: ['kitchen'] },
    });

    expect(await res.json()).toEqual({
      id: 'p3',
      name: 'Mug',
      priceCents: 1200,
      tags: ['kitchen'],
    });
  });
  // #endregion guard
});

describe('overrides', () => {
  // #region use-value
  test('useValue replaces a provider with a ready instance', async () => {
    const seeded = new ProductsService();
    seeded.add({ name: 'Bike light', priceCents: 1800, tags: ['cycling'] });
    mod = await Test.createModule({ imports: [CatalogModule] })
      .overrideProvider(ProductsService)
      .useValue(seeded)
      .compile();
    const app = await mod.createApp();

    const res = await app.request('GET', '/products', { query: { tag: 'cycling' } });

    expect(((await res.json()) as Product[]).map((p) => p.name)).toEqual(['Bike light']);
  });
  // #endregion use-value

  // #region use-class
  class OneProductService extends ProductsService {
    override list(): Product[] {
      return [{ id: 'p1', name: 'Kettle', priceCents: 3900, tags: [] }];
    }
  }

  test('useClass constructs another class in its place', async () => {
    mod = await Test.createModule({ imports: [CatalogModule] })
      .overrideProvider(ProductsService)
      .useClass(OneProductService)
      .compile();

    expect(mod.get(ProductsService)).toBeInstanceOf(OneProductService);
  });
  // #endregion use-class

  // #region use-factory
  test('useFactory builds the replacement, and may be async for providers', async () => {
    mod = await Test.createModule({ imports: [CatalogModule] })
      .overrideProvider(ProductsService)
      .useFactory(async () => {
        const service = new ProductsService();
        service.add({ name: 'Seeded', priceCents: 100, tags: [] });
        return service;
      })
      .compile();

    expect(mod.get(ProductsService).find('p3')?.name).toBe('Seeded');
  });
  // #endregion use-factory

  // #region middleware-filter
  test('middleware and filters are replaced like guards', async () => {
    mod = await Test.createModule({ imports: [CatalogModule] })
      .overrideMiddleware(RequestIdMiddleware)
      .useValue({ use: (_ctx, next) => next() })
      .overrideFilter(StorageErrorFilter)
      .useValue({ catch: () => Response.json({ error: 'test filter' }, { status: 418 }) })
      .overrideProvider(ProductsService)
      .useClass(FailingProducts)
      .compile();
    const app = await mod.createApp();

    const res = await app.request('GET', '/products/p1');

    expect(res.headers.get('x-request-id')).toBeNull();
    expect(res.status).toBe(418);
  });
  // #endregion middleware-filter
});

describe('logs and errors', () => {
  // #region logs
  test('captures log entries', async () => {
    mod = await Test.createModule({ imports: [CatalogModule] })
      .overrideProvider(ProductsService)
      .useClass(UnavailableProducts)
      .compile();
    const app = await mod.createApp();

    const res = await app.request('GET', '/products');

    expect(res.status).toBe(503);
    expect(mod.logs).toContainEqual({
      level: 'warn',
      message: 'catalog storage unavailable',
      meta: [],
    });
  });
  // #endregion logs

  // #region development
  test('development is on by default, so 500 responses carry the error', async () => {
    mod = await Test.createModule({ imports: [CatalogModule] })
      .overrideProvider(ProductsService)
      .useClass(FailingProducts)
      .compile();
    const app = await mod.createApp();

    const body = (await (await app.request('GET', '/products/p1')).json()) as {
      detail?: string;
    };

    expect(body.detail).toBe('disk on fire');
    expect(mod.logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  test('development: false tests the production response', async () => {
    mod = await Test.createModule({ imports: [CatalogModule] })
      .overrideProvider(ProductsService)
      .useClass(FailingProducts)
      .compile({ development: false });
    const app = await mod.createApp();

    const body = (await (await app.request('GET', '/products/p1')).json()) as {
      detail?: string;
      correlationId: string;
    };

    expect(body.detail).toBeUndefined();
    expect(mod.logs).toContainEqual({
      level: 'error',
      message: `Unhandled error on GET /products/p1 (correlation id ${body.correlationId}): Error: disk on fire`,
      meta: [],
    });
  });
  // #endregion development

  // #region logger
  test('compile({ logger }) takes your own logger', async () => {
    const logger = new MemoryLogger();
    mod = await Test.createModule({ imports: [CatalogModule] }).compile({ logger });

    expect(mod.logger).toBe(logger);
  });
  // #endregion logger
});
