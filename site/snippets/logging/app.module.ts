import { Module } from '@knead-js/core';
import { LoggingModule } from '@knead-js/logging';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [
    LoggingModule.forRoot({
      name: 'orders-api',
      fields: { service: 'orders' },
    }),
  ],
  providers: [OrdersService],
})
export class AppModule {}
