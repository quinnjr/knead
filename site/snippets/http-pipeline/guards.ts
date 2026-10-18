import { Injectable, inject, Module } from '@knead-js/core';
import {
  APP_GUARD,
  assertGuardRef,
  Controller,
  type Ctx,
  createRouteDecorator,
  Get,
  type Guard,
  type GuardFn,
  type GuardRef,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@knead-js/http';
import * as v from 'valibot';

export interface User {
  id: string;
  roles: string[];
}

@Injectable()
export class Sessions {
  readonly #byToken = new Map<string, User>([
    ['token-ada', { id: 'ada', roles: ['admin'] }],
    ['token-bob', { id: 'bob', roles: [] }],
  ]);

  async find(token: string): Promise<User | undefined> {
    return this.#byToken.get(token);
  }
}

// #region class
export class SessionGuard implements Guard {
  readonly #sessions = inject(Sessions);

  async canActivate(ctx: Ctx): Promise<boolean> {
    const header = ctx.req.headers.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const user = token === undefined ? undefined : await this.#sessions.find(token);
    if (user === undefined) {
      throw new UnauthorizedException('Sign in first', {
        headers: { 'www-authenticate': 'Bearer' },
      });
    }
    ctx.state.user = user;
    return true;
  }
}

export function currentUser(ctx: Ctx): User | undefined {
  return ctx.state.user as User | undefined;
}
// #endregion class

// #region roles
export const Roles = createRouteDecorator<string[]>('roles');

export const rolesGuard: GuardFn = (ctx) => {
  const required = ctx.meta.roles as string[] | undefined;
  if (required === undefined || required.length === 0) return true;
  const roles = currentUser(ctx)?.roles ?? [];
  return required.some((role) => roles.includes(role));
};
// #endregion roles

// #region authorize
const TransferBody = v.object({
  account: v.pipe(v.string(), v.trim(), v.toLowerCase()),
  amount: v.pipe(v.number(), v.minValue(1)),
});

const ownsAccount = (ctx: Ctx<{ body: v.InferOutput<typeof TransferBody> }>) =>
  ctx.body.account === currentUser(ctx)?.id;
// #endregion authorize

// #region controller
@Controller('/admin')
@UseGuards(SessionGuard, rolesGuard)
export class AdminController {
  @Get('/stats')
  @Roles(['admin'])
  stats() {
    return { users: 2 };
  }

  @Get('/me')
  me(ctx: Ctx) {
    return { id: currentUser(ctx)?.id };
  }

  @Post('/transfers', { body: TransferBody, authorize: [ownsAccount] })
  transfer(ctx: Ctx<{ body: v.InferOutput<typeof TransferBody> }>) {
    return { from: ctx.body.account, amount: ctx.body.amount };
  }
}
// #endregion controller

// #region global
export const blockScanners: GuardFn = (ctx) =>
  !/sqlmap|nikto/i.test(ctx.req.headers.get('user-agent') ?? '');

@Module({
  controllers: [AdminController],
  providers: [Sessions, { provide: APP_GUARD, multi: true, useValue: blockScanners }],
})
export class AppModule {}
// #endregion global

// #region upgrades
export const bearerOrUpgrade: GuardFn = (ctx) =>
  ctx.upgrade !== null || ctx.req.headers.get('authorization')?.startsWith('Bearer ') === true;
// #endregion upgrades

// #region assert
export interface AuditOptions {
  guard: GuardRef;
}

export function auditModuleGuard(options: AuditOptions): GuardRef {
  assertGuardRef(options.guard, 'AuditModule.forRoot({ guard })');
  return options.guard;
}
// #endregion assert
