/** Minimal graphql-transport-ws, graphql-sse and GraphQL-over-HTTP clients for TestApp. */

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
        const error = new Error(`graphql-transport-ws message is not JSON: ${capped(text)}`);
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

/** One server-sent event: its `event` name and its `data` lines joined with newlines. */
export interface SseEvent {
  event: string;
  data: string;
}

/** Parses one event block; undefined for a block of comments only (a keep-alive). */
function sseEvent(block: string): SseEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  let fields = 0;
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    fields++;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return fields === 0 ? undefined : { event, data: data.join('\n') };
}

/**
 * The events of a `text/event-stream` response body, skipping keep-alive comments. `return()`
 * cancels the body (closing the stream), also before the first `next()`.
 */
export function readSse(res: Response): AsyncIterableIterator<SseEvent> {
  const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  /** A trailing `\r` held back until the next chunk shows whether it starts a `\r\n`. */
  let heldCr = false;
  const finish = async (): Promise<IteratorResult<SseEvent>> => {
    await reader?.cancel().catch(() => {});
    return { value: undefined, done: true };
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (!reader) return { value: undefined, done: true };
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const parsed = sseEvent(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (parsed) return { value: parsed, done: false };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) {
          if (!heldCr) return { value: undefined, done: true };
          heldCr = false;
          buffer += '\n';
          continue;
        }
        let chunk = (heldCr ? '\r' : '') + value;
        heldCr = chunk.endsWith('\r');
        if (heldCr) chunk = chunk.slice(0, -1);
        buffer += chunk.replace(/\r\n?/g, '\n');
      }
    },
    return: finish,
  };
}

/** @internal `text` for an error message: at most 1024 characters, then `…`. */
export function capped(text: string): string {
  return text.length > 1024 ? `${text.slice(0, 1024)}…` : text;
}

/**
 * Subscribes over graphql-sse (a POST that asks for `text/event-stream`). Resolves once the
 * response headers arrive: a non-200 status rejects with an Error naming the status and the body,
 * and so does a 200 that is not `text/event-stream` (naming its content type too).
 */
export async function subscribeSse<TData>(
  url: URL,
  query: string,
  options: GraphQLRequestOptions,
): Promise<GraphQLSubscription<TData>> {
  const controller = new AbortController();
  const headers = new Headers({ accept: 'text/event-stream', 'content-type': 'application/json' });
  for (const [key, value] of new Headers(options.headers)) headers.set(key, value);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      variables: options.variables,
      operationName: options.operationName,
    }),
    signal: controller.signal,
    ...(options.tls ? { tls: options.tls } : {}),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => '<unreadable body>');
    throw new Error(`GraphQL SSE request failed (status ${res.status}): ${capped(text)}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!/^text\/event-stream\s*(?:;|$)/i.test(type)) {
    const text = await res.text().catch(() => '<unreadable body>');
    // A JSON answer (SSE turned off, or a server that does not speak graphql-sse) would otherwise
    // read as a stream that ended without complete.
    throw new Error(
      `GraphQL SSE response is not an event stream (status ${res.status}, content-type ` +
        `${type || 'none'}): ${capped(text)}`,
    );
  }
  const events = readSse(res);
  let finished = false;
  let closed = false;
  /** Why the stream ended abnormally; set once, then every later next() rejects with it. */
  let failure: Error | undefined;
  const close = async () => {
    closed = true;
    finished = true;
    controller.abort();
    await events.return?.().catch(() => {});
  };
  const iterator: GraphQLSubscription<TData> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (failure) throw failure;
      if (finished) return { value: undefined, done: true };
      try {
        for (;;) {
          const { value, done } = await events.next();
          if (done) throw new Error('SSE stream ended without a complete event');
          if (value.event === 'complete') {
            await close();
            return { value: undefined, done: true };
          }
          if (value.event !== 'next') continue;
          try {
            return { value: JSON.parse(value.data) as GraphQLPayload<TData>, done: false };
          } catch {
            throw new Error(`graphql-sse next event is not JSON: ${capped(value.data)}`);
          }
        }
      } catch (error) {
        if (closed) return { value: undefined, done: true };
        finished = true;
        failure = error instanceof Error ? error : new Error(String(error));
        controller.abort();
        throw failure;
      }
    },
    async return() {
      await close();
      return { value: undefined, done: true };
    },
    close,
  };
  return iterator;
}
