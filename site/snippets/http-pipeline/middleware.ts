import { Injectable, inject, Module } from '@knead-js/core';
import {
  APP_MIDDLEWARE,
  Controller,
  type Ctx,
  Get,
  type GlobalMiddleware,
  type Middleware,
  type MiddlewareFn,
  ModuleMiddleware,
  type Next,
  Post,
  UnsupportedMediaTypeException,
  UseMiddleware,
  withHeaders,
} from '@knead-js/http';

// #region class
export class RequestTimer implements Middleware {
  async use(_ctx: Ctx, next: Next): Promise<Response> {
    const started = performance.now();
    const res = await next();
    const duration = (performance.now() - started).toFixed(1);
    return withHeaders(res, { 'server-timing': `app;dur=${duration}` });
  }
}
// #endregion class

// #region function
export const requestId: MiddlewareFn = async (ctx, next) => {
  const id = crypto.randomUUID();
  ctx.state.requestId = id;
  return withHeaders(await next(), { 'x-request-id': id });
};
// #endregion function

// #region short-circuit
@Injectable()
export class MaintenanceSwitch {
  enabled = false;
}

export class MaintenanceMode implements Middleware {
  readonly #maintenance = inject(MaintenanceSwitch);

  use(_ctx: Ctx, next: Next): Response | Promise<Response> {
    if (this.#maintenance.enabled) {
      return new Response('Down for maintenance', {
        status: 503,
        headers: { 'retry-after': '120', 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return next();
  }
}
// #endregion short-circuit

// #region throw
export const requireJson: MiddlewareFn = (ctx, next) => {
  const type = ctx.req.headers.get('content-type') ?? '';
  if (ctx.req.body !== null && !type.startsWith('application/json')) {
    throw new UnsupportedMediaTypeException('Send application/json');
  }
  return next();
};
// #endregion throw

// #region scopes
const noStore: MiddlewareFn = async (_ctx, next) =>
  withHeaders(await next(), { 'cache-control': 'no-store' });

@Controller('/reports', { middleware: [RequestTimer] })
export class ReportsController {
  @Get('/daily')
  daily() {
    return { visits: 1204 };
  }

  @Post('/export', { middleware: [requireJson] })
  export() {
    return { queued: true };
  }

  @Get('/live')
  @UseMiddleware(noStore)
  live() {
    return { online: 18 };
  }
}

@ModuleMiddleware(requestId)
@Module({ controllers: [ReportsController] })
export class ReportsModule {}
// #endregion scopes

// #region global
@Module({
  imports: [ReportsModule],
  providers: [
    MaintenanceSwitch,
    {
      provide: APP_MIDDLEWARE,
      multi: true,
      useValue: { middleware: MaintenanceMode, priority: 500 } satisfies GlobalMiddleware,
    },
  ],
})
export class AppModule {}
// #endregion global
