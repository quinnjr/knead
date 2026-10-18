import { Injectable, inject, LOGGER, Module } from '@knead-js/core';
import {
  Controller,
  type Ctx,
  type ExceptionFilter,
  Get,
  type Guard,
  type Middleware,
  type Next,
  NotFoundException,
  Post,
  UseFilters,
  UseGuards,
  UseMiddleware,
} from '@knead-js/http';

export interface Product {
  id: string;
  name: string;
  priceCents: number;
  tags: string[];
}

@Injectable()
export class ProductsService {
  readonly #products = new Map<string, Product>([
    ['p1', { id: 'p1', name: 'Kettle', priceCents: 3900, tags: ['kitchen'] }],
    ['p2', { id: 'p2', name: 'Desk lamp', priceCents: 2500, tags: ['office', 'lighting'] }],
  ]);

  find(id: string): Product | undefined {
    return this.#products.get(id);
  }

  list(tags: readonly string[]): Product[] {
    const all = [...this.#products.values()];
    return tags.length === 0 ? all : all.filter((p) => tags.some((t) => p.tags.includes(t)));
  }

  add(input: Omit<Product, 'id'>): Product {
    const product = { id: `p${this.#products.size + 1}`, ...input };
    this.#products.set(product.id, product);
    return product;
  }
}

/** Lets a request through only with the admin API key. */
export class AdminGuard implements Guard {
  canActivate(ctx: Ctx): boolean {
    return ctx.req.headers.get('x-api-key') === process.env.ADMIN_API_KEY;
  }
}

/** Echoes or creates an `x-request-id` header. */
export class RequestIdMiddleware implements Middleware {
  async use(ctx: Ctx, next: Next): Promise<Response> {
    const id = ctx.req.headers.get('x-request-id') ?? crypto.randomUUID();
    const res = await next();
    res.headers.set('x-request-id', id);
    return res;
  }
}

/** Thrown when the product store cannot be reached. */
export class StorageError extends Error {
  override name = 'StorageError';
}

/** Answers StorageError with a 503. */
export class StorageErrorFilter implements ExceptionFilter {
  readonly #log = inject(LOGGER);

  catch(error: unknown): Response | undefined {
    if (!(error instanceof StorageError)) return undefined;
    this.#log.warn('catalog storage unavailable');
    return Response.json({ error: 'catalog unavailable' }, { status: 503 });
  }
}

@Controller('/products')
@UseMiddleware(RequestIdMiddleware)
@UseFilters(StorageErrorFilter)
export class ProductsController {
  readonly #products = inject(ProductsService);

  @Get('/')
  list(ctx: Ctx) {
    const tag = ctx.query.tag ?? [];
    return this.#products.list(typeof tag === 'string' ? [tag] : tag);
  }

  @Get('/:id')
  get(ctx: Ctx<{ params: { id: string } }>) {
    const product = this.#products.find(ctx.params.id);
    if (!product) throw new NotFoundException(`No product ${ctx.params.id}`);
    return product;
  }

  @Post('/')
  @UseGuards(AdminGuard)
  async create(ctx: Ctx) {
    return this.#products.add(await ctx.json<Omit<Product, 'id'>>());
  }
}

@Module({
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class CatalogModule {}
