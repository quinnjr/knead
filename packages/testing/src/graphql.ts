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
}

export interface GraphQLSubscribeOptions extends GraphQLRequestOptions {
  /** Sent as the connection_init payload. */
  connectionParams?: Record<string, unknown>;
}

/** Yields each `next` payload; an `error` message is yielded as `{ errors }` and ends it. */
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
  } as unknown as string[]);
  const queue: GraphQLPayload<TData>[] = [];
  const waiting: ((result: IteratorResult<GraphQLPayload<TData>>) => void)[] = [];
  let finished = false;
  const deliver = (payload: GraphQLPayload<TData>) => {
    const waiter = waiting.shift();
    if (waiter) waiter({ value: payload, done: false });
    else queue.push(payload);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const waiter of waiting.splice(0)) waiter({ value: undefined, done: true });
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
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiting.push(resolve));
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
      const message = JSON.parse(String(event.data)) as { type: string; payload?: unknown };
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
      finish();
    };
    socket.onerror = () => reject(new Error('WebSocket connection failed'));
  });
}
