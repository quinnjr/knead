/** Minimal graphql-transport-ws and GraphQL-over-HTTP clients for TestApp. */

export interface GraphQLErrorJson {
  message: string;
  locations?: { line: number; column: number }[];
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

export interface GraphQLPayload<TData = Record<string, unknown>> {
  data?: TData | null;
  errors?: GraphQLErrorJson[];
  extensions?: Record<string, unknown>;
}

export interface GraphQLResult<TData = Record<string, unknown>> extends GraphQLPayload<TData> {
  /** HTTP status of the response. */
  status: number;
  headers: Headers;
}

export interface GraphQLRequestOptions {
  variables?: Record<string, unknown>;
  operationName?: string;
  headers?: Bun.HeadersInit;
  /** Default '/graphql'. */
  path?: string;
  /**
   * TLS options for an HTTPS test server. `rejectUnauthorized: false` accepts any certificate
   * (for self-signed test certificates): tests only, never in application code.
   */
  tls?: {
    /** `false` skips certificate verification. Tests only. */
    rejectUnauthorized?: boolean;
  };
}

export interface GraphQLSubscribeOptions extends GraphQLRequestOptions {
  /** Sent as the connection_init payload. */
  connectionParams?: Record<string, unknown>;
}

/**
 * Yields each `next` payload; an `error` message is yielded as `{ errors }` and ends it, as does
 * `complete` or a normal (1000) close. A close with any other code before that, or a frame that is
 * not JSON, makes `next()` reject (after the payloads already received).
 */
export interface GraphQLSubscription<TData = Record<string, unknown>>
  extends AsyncIterableIterator<GraphQLPayload<TData>> {
  /** Sends `complete` and closes the socket. */
  close(): Promise<void>;
}

export function subscribe<TData>(
  url: URL,
  query: string,
  options: GraphQLSubscribeOptions,
): Promise<GraphQLSubscription<TData>> {
  const socket = new WebSocket(url.toString(), {
    protocols: ['graphql-transport-ws'],
    headers: options.headers,
    ...(options.tls ? { tls: options.tls } : {}),
  } as unknown as string[]);
  interface Waiter {
    resolve: (result: IteratorResult<GraphQLPayload<TData>>) => void;
    reject: (error: Error) => void;
  }
  const queue: GraphQLPayload<TData>[] = [];
  const waiting: Waiter[] = [];
  let finished = false;
  /** Why the subscription ended abnormally; set once, then every later next() rejects with it. */
  let failure: Error | undefined;
  const deliver = (payload: GraphQLPayload<TData>) => {
    const waiter = waiting.shift();
    if (waiter) waiter.resolve({ value: payload, done: false });
    else queue.push(payload);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const waiter of waiting.splice(0)) waiter.resolve({ value: undefined, done: true });
  };
  const fail = (error: Error) => {
    if (finished) return;
    finished = true;
    failure = error;
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  };
  const close = async () => {
    if (socket.readyState === WebSocket.OPEN && !finished) {
      socket.send(JSON.stringify({ id: '1', type: 'complete' }));
    }
    finish();
    socket.close(1000);
  };
  const iterator: GraphQLSubscription<TData> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      const payload = queue.shift();
      if (payload) return Promise.resolve({ value: payload, done: false });
      if (failure) return Promise.reject(failure);
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    async return() {
      await close();
      return { value: undefined, done: true };
    },
    close,
  };
  return new Promise((resolve, reject) => {
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'connection_init', payload: options.connectionParams }));
    };
    socket.onmessage = (event) => {
      let message: { type: string; payload?: unknown };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        const text = String(event.data);
        const shown = text.length > 1024 ? `${text.slice(0, 1024)}…` : text;
        const error = new Error(`graphql-transport-ws message is not JSON: ${shown}`);
        reject(error);
        fail(error);
        socket.close(4400, 'Invalid message');
        return;
      }
      switch (message.type) {
        case 'connection_ack':
          socket.send(
            JSON.stringify({
              id: '1',
              type: 'subscribe',
              payload: {
                query,
                variables: options.variables,
                operationName: options.operationName,
              },
            }),
          );
          resolve(iterator);
          break;
        case 'ping':
          socket.send(JSON.stringify({ type: 'pong' }));
          break;
        case 'next':
          deliver(message.payload as GraphQLPayload<TData>);
          break;
        case 'error':
          deliver({ errors: message.payload as GraphQLErrorJson[] });
          finish();
          break;
        case 'complete':
          finish();
          break;
      }
    };
    socket.onclose = (event) => {
      reject(new Error(`WebSocket closed before connection_ack: ${event.code} ${event.reason}`));
      // Only `complete`, `error` or a normal close end it; anything else is a failure, not the
      // end of the stream (a revoked socket, a server error).
      if (event.code === 1000) finish();
      else fail(new Error(`WebSocket closed: ${event.code} ${event.reason}`));
    };
    socket.onerror = () => reject(new Error('WebSocket connection failed'));
  });
}
