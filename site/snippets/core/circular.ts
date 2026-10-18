import { Injectable, inject, Module } from '@knead-js/core';

// #region cycle
@Injectable()
export class OrdersService {
  // OrdersService → InvoicesService → OrdersService
  readonly invoices: InvoicesService = inject(InvoicesService);
}

@Injectable()
export class InvoicesService {
  readonly orders: OrdersService = inject(OrdersService);
}
// #endregion cycle

@Module({ providers: [OrdersService, InvoicesService] })
export class CyclicModule {}

// #region fix
// The logic both services needed moves into a third provider that depends on neither.
@Injectable()
export class PricingService {
  totalCents(lines: number[]): number {
    return lines.reduce((sum, cents) => sum + cents, 0);
  }
}

@Injectable()
export class Orders {
  readonly pricing = inject(PricingService);
}

@Injectable()
export class Invoices {
  readonly pricing = inject(PricingService);
}
// #endregion fix

@Module({ providers: [PricingService, Orders, Invoices] })
export class BillingModule {}
