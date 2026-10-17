import { inject } from '@knead-js/core';
import { Interval, type JobContext } from '@knead-js/schedule';

export class InventorySync {
  async run(signal: AbortSignal): Promise<void> {
    for (let page = 0; page < 10; page++) {
      if (signal.aborted) return;
      await Bun.sleep(5);
    }
  }
}

// #region overlap
export class InventoryJobs {
  readonly sync = inject(InventorySync);
  #running = false;

  @Interval('1m')
  async syncInventory({ signal }: JobContext) {
    // A new run starts every minute even if the last one is still going.
    if (this.#running) return;
    this.#running = true;
    try {
      await this.sync.run(signal);
    } finally {
      this.#running = false;
    }
  }
}
// #endregion overlap
