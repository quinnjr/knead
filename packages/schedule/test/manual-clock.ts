import type { Clock } from '../src/clock.js';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** Lets microtasks and pending I/O callbacks run. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A Clock whose time only moves when a test advances it. */
export class ManualClock implements Clock {
  #now: number;
  #nextId = 0;
  readonly #timers = new Map<number, Timer>();
  /** Every delay passed to setTimeout, in order. */
  readonly delays: number[] = [];

  constructor(start: number | string = '2026-01-01T00:00:00.000Z') {
    this.#now = typeof start === 'number' ? start : Date.parse(start);
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.#nextId;
    this.delays.push(ms);
    this.#timers.set(id, { id, at: this.#now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pending(): number {
    return this.#timers.size;
  }

  /** Moves time forward, firing due timers in order and letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await flush();
      let due: Timer | undefined;
      for (const t of this.#timers.values()) {
        if (t.at <= target && (!due || t.at < due.at || (t.at === due.at && t.id < due.id)))
          due = t;
      }
      if (!due) break;
      this.#timers.delete(due.id);
      this.#now = Math.max(this.#now, due.at);
      due.fn();
    }
    this.#now = target;
    await flush();
  }

  /** Moves time without firing timers, like a suspended process or a blocked event loop. */
  jump(ms: number): void {
    this.#now += ms;
  }

  /** Fires the earliest timer now, before its due time (an early-firing timer). */
  fireEarliestEarly(): void {
    let due: Timer | undefined;
    for (const t of this.#timers.values()) if (!due || t.at < due.at) due = t;
    if (!due) throw new Error('no timers');
    this.#timers.delete(due.id);
    due.fn();
  }
}

/** A promise with its resolve function exposed. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
