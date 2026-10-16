import { Module } from '@knead/core';
import { AuthModule } from '../auth/auth.js';
import { UsersController } from './users.controller.js';
import { UsersResolver } from './users.resolver.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService, UsersResolver],
})
export class UsersModule {}
