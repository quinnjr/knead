import { ApplicationContext, Injectable, inject, MemoryLogger, Module } from '@knead-js/core';

@Injectable()
export class PaymentGateway {
  charge(cents: number): string {
    return `charged ${cents} through the real gateway`;
  }
}

@Injectable()
export class CheckoutService {
  readonly gateway = inject(PaymentGateway);
}

@Module({ providers: [PaymentGateway, CheckoutService] })
export class CheckoutModule {}

// #region overrides
export class FakeGateway extends PaymentGateway {
  override charge(cents: number): string {
    return `pretended to charge ${cents}`;
  }
}

export async function createTestContext(): Promise<ApplicationContext> {
  return ApplicationContext.create(CheckoutModule, {
    overrides: [[PaymentGateway, { provide: PaymentGateway, useClass: FakeGateway }]],
    logger: new MemoryLogger(),
    development: true,
  });
}
// #endregion overrides
