import { InjectionToken, inject, Module } from '@knead-js/core';

// #region basic
export class PriceFormatter {
  format(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

export class CartService {
  // Field initializers run inside the injection context.
  readonly formatter = inject(PriceFormatter);

  total(items: number[]): string {
    return this.formatter.format(items.reduce((sum, cents) => sum + cents, 0));
  }
}
// #endregion basic

// #region constructor
export const CURRENCY = new InjectionToken<string>('CURRENCY');

export class InvoiceService {
  readonly prefix: string;

  constructor() {
    // The constructor body runs in the injection context too.
    const currency = inject(CURRENCY);
    this.prefix = `INV-${currency}`;
  }
}
// #endregion constructor

// #region optional
export interface Tracer {
  span(name: string): void;
}

export const TRACER = new InjectionToken<Tracer>('TRACER');

export class CheckoutService {
  readonly tracer = inject(TRACER, { optional: true });

  checkout(): string {
    this.tracer?.span('checkout');
    return 'ok';
  }
}
// #endregion optional

@Module({
  providers: [
    PriceFormatter,
    CartService,
    InvoiceService,
    CheckoutService,
    { provide: CURRENCY, useValue: 'USD' },
  ],
})
export class ShopModule {}
