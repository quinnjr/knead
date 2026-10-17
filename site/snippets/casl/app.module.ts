import { CaslModule } from '@knead-js/casl';
import { Module } from '@knead-js/core';
import { permissions } from './permissions.js';
import { PostsController } from './posts.controller.js';
import { UsersController } from './users.controller.js';
import { defineUserAbility, sessionFrom, type User } from './users.js';

// #region module
@Module({
  imports: [
    CaslModule.forRoot<User>({
      permissions,
      // Who is calling and with which grant; undefined or null means unauthenticated (401).
      resolve: (ctx) => ('req' in ctx ? sessionFrom(ctx.req) : undefined),
      defineUserAbility,
    }),
  ],
  controllers: [PostsController, UsersController],
})
export class AppModule {}
// #endregion module
