import { type Ctx, WS_DEFAULTS } from '@knead-js/http';
import { type ErrorMaskingOptions, logInternalError } from './errors.js';
import {
  type ConnectionParams,
  DEFAULT_CONNECTION_INIT_TIMEOUT,
  type ResolvedGraphQLOptions,
} from './options.js';
import type { GraphQLConnection } from './subscriptions.js';

// The connection handshake and deferred revocations shared by both subscription transports
// (graphql-transport-ws in subscriptions.ts, graphql-sse in sse.ts). Each transport keeps only
// what its protocol decides: close codes for a socket, HTTP statuses for a stream.

/** A subscription transport, as log messages name it. */
export type SubscriptionTransport = 'WebSocket' | 'SSE';

/** A connection's identity, computed once when it connects. */
export interface ConnectionIdentity {
  /** The `context(http)` factory result. */
  readonly base: object | undefined;
  /** The object `onConnect` returned, merged into every operation's context. */
  readonly extra: object | undefined;
}

/** The context of a connection whose identity is not known yet (or carries nothing). */
export const EMPTY_CONTEXT: Readonly<Record<PropertyKey, unknown>> = Object.freeze({});

/** `connection.context`: the factory result with the onConnect result merged over it. */
export function identityContext(
  identity: ConnectionIdentity | undefined,
): Readonly<Record<PropertyKey, unknown>> {
  if (!identity?.base && !identity?.extra) return EMPTY_CONTEXT;
  return Object.freeze({ ...identity.base, ...identity.extra });
}

/** What the handshake reads from its GraphQLRuntime. */
export interface HandshakeHost {
  readonly options: Pick<ResolvedGraphQLOptions, 'context'> & {
    readonly subscriptions?: ResolvedGraphQLOptions['subscriptions'];
  };
  readonly masking: ErrorMaskingOptions;
  readonly logger: { warn(message: string): void; debug(message: string): void };
}

/** `subscriptions.connectionInitTimeout`, or its default. */
export function connectionInitTimeoutOf(host: HandshakeHost): number {
  const subscriptions = host.options.subscriptions;
  return (subscriptions || undefined)?.connectionInitTimeout ?? DEFAULT_CONNECTION_INIT_TIMEOUT;
}

export interface Handshake {
  /** The connecting request's Ctx (the upgrade request over WebSocket). */
  readonly http: Ctx;
  /** The `connection_init` payload over WebSocket, `{}` over SSE. */
  readonly params: ConnectionParams;
  readonly transport: SubscriptionTransport;
  /** True once the connection has gone (closed, ended): onConnect is then skipped. */
  readonly isGone: () => boolean;
}

/**
 * The identity of a connecting subscription: the `context(http)` factory, then
 * `onConnect(http, params)`. `false` when either refuses: onConnect returning `false`, or a throw
 * from either (fail closed, logged; a connection accepted without its identity could slip past
 * closeWhere predicates). onConnect is skipped once the connection has gone while the factory
 * ran. Never throws.
 *
 * Still pending after `connectionInitTimeout`, it logs a warning (the transport has answered the
 * client by then, but the connection slot stays held until the work settles), and a debug line
 * once it settles.
 */
export async function resolveConnectionIdentity(
  host: HandshakeHost,
  { http, params, transport, isGone }: Handshake,
): Promise<ConnectionIdentity | false> {
  const started = Date.now();
  const timeout = connectionInitTimeoutOf(host);
  let late = false;
  const watchdog = setTimeout(() => {
    late = true;
    host.logger.warn(
      `GraphQL ${transport} subscription: the context factory or onConnect is still pending after ${timeout} ms; its connection slot stays held until it settles.`,
    );
  }, timeout);
  try {
    return await handshake(host, http, params, transport, isGone);
  } finally {
    clearTimeout(watchdog);
    if (late) {
      host.logger.debug(
        `GraphQL ${transport} subscription: the pending context factory or onConnect settled after ${Date.now() - started} ms; its connection slot is released.`,
      );
    }
  }
}

async function handshake(
  host: HandshakeHost,
  http: Ctx,
  params: ConnectionParams,
  transport: SubscriptionTransport,
  isGone: () => boolean,
): Promise<ConnectionIdentity | false> {
  let base: object | undefined;
  if (host.options.context) {
    try {
      base = await host.options.context(http);
    } catch (error) {
      logInternalError(
        host.masking,
        `GraphQL context factory threw at connection_init; rejecting the ${transport} connection`,
        error,
      );
      return false;
    }
  }
  if (isGone()) return false;
  const onConnect = (host.options.subscriptions || undefined)?.onConnect;
  let extra: object | undefined;
  if (onConnect) {
    try {
      const result = await onConnect(http, params);
      if (result === false) return false;
      if (typeof result === 'object' && result !== null) extra = result;
    } catch (error) {
      logInternalError(
        host.masking,
        `GraphQL subscriptions onConnect threw; rejecting the ${transport} connection`,
        error,
      );
      return false;
    }
  }
  return { base, extra };
}

export type ConnectionPredicate = (connection: GraphQLConnection) => boolean;

/**
 * Whether `predicate` revokes `connection`: truthy revokes (a revocation errs towards ending the
 * connection); a throw is logged and does not.
 */
export function revokes(
  predicate: ConnectionPredicate,
  connection: GraphQLConnection,
  masking: ErrorMaskingOptions,
): boolean {
  try {
    return Boolean(predicate(connection));
  } catch (error) {
    logInternalError(masking, 'GraphQLSubscriptions.closeWhere predicate threw', error);
    return false;
  }
}

/**
 * The GraphQLSubscriptions.closeWhere revocations kept for one connection whose identity is not
 * known yet (it is upgrading, or its context factory or onConnect is pending), applied to that
 * identity by settle(). At most `max` are kept (`listen({ websocket: { maxPendingRevocations } })`,
 * default 10000): keep() refuses the next one, and the transport must then end the connection
 * (fail closed) rather than let a revocation escape.
 */
export class DeferredRevocations<R extends { readonly predicate: ConnectionPredicate }> {
  readonly #max: number;
  #kept: R[] = [];
  #overflowed = false;

  constructor(max: number | undefined) {
    this.#max = max ?? WS_DEFAULTS.maxPendingRevocations;
  }

  /** Keeps `revocation`; false (and overflowed) when `max` are already kept. */
  keep(revocation: R): boolean {
    if (this.#overflowed || this.#kept.length >= this.#max) {
      this.#overflowed = true;
      this.#kept = [];
      return false;
    }
    this.#kept.push(revocation);
    return true;
  }

  /** Whether keep() refused a revocation: the connection must be ended. */
  get overflowed(): boolean {
    return this.#overflowed;
  }

  /** The first kept revocation that revokes `connection` (its full identity), forgetting them all. */
  settle(connection: GraphQLConnection, masking: ErrorMaskingOptions): R | undefined {
    const kept = this.#kept;
    this.#kept = [];
    return kept.find((revocation) => revokes(revocation.predicate, connection, masking));
  }

  /** Forgets the kept revocations (the connection has gone). */
  clear(): void {
    this.#kept = [];
  }
}
