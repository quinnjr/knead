import { inject, LOGGER } from '@knead-js/core';

export interface Order {
  id: string;
  customerId: string;
  totalCents: number;
}

export class PaymentDeclinedError extends Error {
  override name = 'PaymentDeclinedError';
}

export class OrdersService {
  readonly #log = inject(LOGGER);

  place(order: Order): void {
    this.#log.info('order placed', { orderId: order.id, totalCents: order.totalCents });
  }

  charge(order: Order, error: unknown): void {
    // Pass the error itself as meta: the logger decides how much of it to write.
    this.#log.error('payment failed', error, { orderId: order.id });
  }
}
