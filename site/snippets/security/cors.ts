import { Module } from '@knead-js/core';
import { CorsModule, type CorsOptions } from '@knead-js/cors';
import { Controller, type Ctx, Get } from '@knead-js/http';

@Controller('/api')
export class ProjectsController {
  @Get('/projects')
  list() {
    return [{ id: 1, name: 'Apollo' }];
  }
}

// #region list
export const allowListCors: CorsOptions = {
  origin: ['https://app.example.com', 'https://admin.example.com'],
  credentials: true,
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
  maxAge: 600,
};
// #endregion list

// #region regexp
export const previewCors: CorsOptions = {
  // Anchored with ^ and $; alternatives grouped inside the anchors.
  origin: /^https:\/\/(?:[a-z0-9-]+\.)?preview\.example\.com$/,
};
// #endregion regexp

// #region predicate
const tenants = new Set(['https://acme.example.com', 'https://globex.example.com']);

// Browsers never send author headers such as x-tenant on a preflight, so the predicate
// requires the header only on the actual request.
const isPreflight = (ctx: Ctx) =>
  ctx.req.method === 'OPTIONS' && ctx.req.headers.has('access-control-request-method');

export const tenantCors: CorsOptions = {
  origin: (origin: string, ctx: Ctx) =>
    tenants.has(origin) && (isPreflight(ctx) || ctx.req.headers.get('x-tenant') !== null),
  allowedHeaders: ['content-type', 'authorization', 'x-tenant'],
  methods: ['GET', 'POST'],
};
// #endregion predicate

// #region module
@Module({
  imports: [CorsModule.forRoot(allowListCors)],
  controllers: [ProjectsController],
})
export class AppModule {}
// #endregion module
