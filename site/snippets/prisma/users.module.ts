import { Module } from '@knead-js/core';
import { UsersController } from './users.controller.js';
import { AuditLog, OrdersRepository, UsersRepository } from './users.repository.js';
import { ImportService, SignupService } from './users.service.js';

@Module({
  controllers: [UsersController],
  providers: [UsersRepository, OrdersRepository, AuditLog, SignupService, ImportService],
})
export class UsersModule {}
