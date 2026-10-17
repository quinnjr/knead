import { Module } from '@knead-js/core';
import { Controller, type Ctx, Delete, Get } from '@knead-js/http';

// #region names
@Controller('/users')
export class UsersController {
  @Get('/:id')
  find(ctx: Ctx<{ params: { id: string } }>) {
    return { id: ctx.params.id };
  }

  // HttpConfigError at listen(): Routes /users/:id and /users/:userId differ only in parameter
  // names; use the same names (UsersController.remove).
  @Delete('/:userId')
  remove(ctx: Ctx<{ params: { userId: string } }>) {
    return { removed: ctx.params.userId };
  }
}
// #endregion names

@Module({ controllers: [UsersController] })
export class ConflictingNamesModule {}

@Controller('/health')
export class HealthController {
  @Get('/') check() {
    return { status: 'ok' };
  }
}

@Controller('/health')
export class StatusController {
  @Get('/') status() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController, StatusController] })
export class DuplicateRouteModule {}
