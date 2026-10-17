import { Module } from '@knead-js/core';
import { AuthModule } from '../auth/auth.js';
import { UsersController } from './users.controller.js';
import { UsersResolver } from './users.resolver.js';
import { UsersService } from './users.service.js';
import { UsersStats } from './users.stats.js';

@Module({
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService, UsersResolver, UsersStats],
})
export class UsersModule {}
