import { Controller, type Ctx, Get, type MiddlewareFn, Post, UseMiddleware } from '@knead-js/http';

// #region state-type
declare module '@knead-js/http' {
  interface CtxState {
    /** Set by tenantMiddleware from the X-Tenant header. */
    tenant?: string;
  }
}
// #endregion state-type

// #region state-middleware
export const tenantMiddleware: MiddlewareFn = (ctx, next) => {
  ctx.state.tenant = ctx.headers['x-tenant'] ?? 'public';
  return next();
};
// #endregion state-middleware

// #region inspect
@Controller('/inspect')
@UseMiddleware(tenantMiddleware)
export class InspectController {
  @Get('/:id')
  show(ctx: Ctx<{ params: { id: string } }>) {
    return {
      id: ctx.params.id,
      tags: ctx.query.tag, // string, string[] or undefined
      agent: ctx.headers['user-agent'],
      tenant: ctx.state.tenant,
      route: ctx.route?.path,
    };
  }
}
// #endregion inspect

// #region body
@Controller('/notes')
export class NotesController {
  @Post('/')
  async create(ctx: Ctx) {
    const input = await ctx.json<{ text?: unknown }>();
    return { received: typeof input?.text === 'string' ? input.text : null };
  }
}
// #endregion body
