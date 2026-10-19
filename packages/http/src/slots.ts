import { ServiceUnavailableException, TooManyRequestsException } from './exceptions.js';
import { maskIp } from './net.js';

/** The limits ConnectionSlots enforces (from the resolved `listen({ websocket })` options). */
export interface ConnectionSlotLimits {
  readonly maxConnectionsPerIp: number | false;
  readonly ipv6Subnet: number;
  readonly maxConnections: number | undefined;
}

/** What a slot is taken for; it names the connections in the 429 / 503 messages. */
export type ConnectionSlotKind = 'WebSocket' | 'streaming';

/**
 * @internal Connection slots shared by WebSocket connections and streaming responses: at most
 * `maxConnectionsPerIp` per client IP (IPv6 grouped by `ipv6Subnet`, 429 past it) and
 * `maxConnections` in total (503). A slot is keyed by an object (socket or stream data). Not
 * exported from the package: WsRegistry owns the instance and StreamRegistry shares it.
 */
export class ConnectionSlots {
  #limits: ConnectionSlotLimits;
  /** Data objects holding a slot, with the key (masked IP) they count against. */
  readonly #reserved = new WeakMap<object, string | undefined>();
  /** Pending hold() calls per data object: release() keeps the slot until they are done. */
  readonly #holds = new WeakMap<object, number>();
  /** Data released while held: the last hold to finish returns the slot. */
  readonly #releasedWhileHeld = new WeakSet<object>();
  readonly #perIp = new Map<string, number>();
  #total = 0;

  constructor(limits: ConnectionSlotLimits) {
    this.#limits = limits;
  }

  configure(limits: ConnectionSlotLimits): void {
    this.#limits = limits;
  }

  /** The key a connection from `ip` counts against: its masked IP, or none when unlimited. */
  keyOf(ip: string | undefined): string | undefined {
    if (this.#limits.maxConnectionsPerIp === false || ip === undefined) return undefined;
    return maskIp(ip, this.#limits.ipv6Subnet);
  }

  /** Whether `data` holds a slot. */
  has(data: object): boolean {
    return this.#reserved.has(data);
  }

  /** The key the slot of `data` counts against (undefined when none, or when it holds none). */
  keyHeldBy(data: object): string | undefined {
    return this.#reserved.get(data);
  }

  /**
   * Takes a slot for `data` counted against `key` (from keyOf()), or throws 429 / 503 naming the
   * `kind` of connection.
   */
  take(data: object, key: string | undefined, kind: ConnectionSlotKind): void {
    const { maxConnections, maxConnectionsPerIp } = this.#limits;
    if (maxConnections !== undefined && this.#total >= maxConnections) {
      throw new ServiceUnavailableException(`Too many ${kind} connections.`);
    }
    if (key !== undefined && (this.#perIp.get(key) ?? 0) >= (maxConnectionsPerIp as number)) {
      throw new TooManyRequestsException(`Too many ${kind} connections from this address.`);
    }
    this.#total++;
    if (key !== undefined) this.#perIp.set(key, (this.#perIp.get(key) ?? 0) + 1);
    this.#reserved.set(data, key);
  }

  /** Returns the slot held by `data` at once, if any, whatever holds are pending. */
  giveBack(data: object): void {
    if (!this.#reserved.has(data)) return;
    const key = this.#reserved.get(data);
    this.#reserved.delete(data);
    this.#total--;
    if (key !== undefined) {
      const count = (this.#perIp.get(key) ?? 1) - 1;
      if (count > 0) this.#perIp.set(key, count);
      else this.#perIp.delete(key);
    }
  }

  /**
   * Returns the slot held by `data`, if any. While a hold() of it is pending, the slot is
   * returned only when the last hold is done.
   */
  release(data: object): void {
    if (this.#holds.has(data)) {
      this.#releasedWhileHeld.add(data);
      return;
    }
    this.giveBack(data);
  }

  /**
   * Keeps the slot of `data` taken while work for it is pending, even after release(). Returns
   * `done`, which ends the hold (idempotent); data released meanwhile then gives its slot back.
   */
  hold(data: object): () => void {
    this.#holds.set(data, (this.#holds.get(data) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.#holds.get(data) ?? 1) - 1;
      if (left > 0) {
        this.#holds.set(data, left);
        return;
      }
      this.#holds.delete(data);
      if (this.#releasedWhileHeld.delete(data)) this.giveBack(data);
    };
  }
}
