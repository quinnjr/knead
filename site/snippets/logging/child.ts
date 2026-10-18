import { Injectable, inject, LOGGER } from '@knead-js/core';
import { childLogger } from '@knead-js/logging';

@Injectable()
export class InvoiceJob {
  // Every entry from this class carries `component: 'invoices'`.
  readonly #log = childLogger(inject(LOGGER), { component: 'invoices' });

  run(batchId: string, invoices: number): void {
    const batchLog = childLogger(this.#log, { batchId });
    batchLog.info('batch started', { invoices });
    batchLog.info('batch finished');
  }
}
