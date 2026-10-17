import { Controller, type Ctx, createRouteDecorator, Get } from '@knead-js/http';

// #region decorator
export const Roles = createRouteDecorator<readonly string[]>('roles');

@Controller('/reports', { meta: { audit: true } })
@Roles(['staff'])
export class ReportsController {
  @Get('/daily')
  daily(ctx: Ctx) {
    return ctx.meta; // { audit: true, roles: ['staff'] }
  }

  @Get('/payroll', { meta: { audit: 'strict' } })
  @Roles(['finance'])
  payroll(ctx: Ctx) {
    return ctx.meta; // { audit: 'strict', roles: ['finance'] }
  }
}
// #endregion decorator
