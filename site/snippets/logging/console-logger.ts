import { ConsoleLogger, LOGGER, Module } from '@knead-js/core';

/** A global module's LOGGER is used by every module of the application. */
@Module({
  global: true,
  providers: [{ provide: LOGGER, useValue: new ConsoleLogger('orders') }],
  exports: [LOGGER],
})
export class OrdersLoggerModule {}
