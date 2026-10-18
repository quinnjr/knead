import type { ModuleImport, Provider } from '@knead-js/core';
import type { ListenOptions } from '@knead-js/http';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import {
  GraphQLModule,
  type GraphQLModuleOptions,
  GraphQLRuntime,
  printSortedSchema,
} from '../src/index.js';

export interface Started {
  mod: TestingModule;
  app: TestApp;
}

/**
 * Boots an app with GraphQLModule.forRoot(options) plus `imports`, listening on a random port
 * with `listen` (for example `{ websocket: { maxConnectionsPerIp: 1 } }`).
 */
export async function startGraphQL(
  imports: ModuleImport[],
  options: GraphQLModuleOptions = {},
  providers: Provider[] = [],
  listen: ListenOptions = {},
): Promise<Started> {
  const mod = await Test.createModule({
    imports: [GraphQLModule.forRoot(options), ...imports],
    providers,
  }).compile({ development: false });
  const app = await mod.createApp(listen);
  return { mod, app };
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
        if (done) return { value: undefined, done: true };
        buffer += value.replaceAll('\r\n', '\n');
      }
    },
    return: finish,
  };
}

/** Bootstraps without listening and returns the sorted SDL. */
export async function sdlOf(
  imports: ModuleImport[],
  options: GraphQLModuleOptions = {},
): Promise<string> {
  const mod = await Test.createModule({
    imports: [GraphQLModule.forRoot(options), ...imports],
  }).compile({ development: false });
  try {
    return printSortedSchema(mod.get(GraphQLRuntime).schema);
  } finally {
    await mod.close();
  }
}

/** Polls until `check` is true (default 2s), for state that settles asynchronously. */
export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('until(): condition not met in time');
    await Bun.sleep(5);
  }
}

/** Sends a raw graphql-transport-ws upgrade request and returns the HTTP status code (`host` overrides Host). */
export function upgradeStatus(app: TestApp, headers: Record<string, string> = {}): Promise<number> {
  const port = Number(app.url.port);
  return new Promise((resolve, reject) => {
    let buf = '';
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(sock) {
          const { host = `127.0.0.1:${port}`, ...rest } = headers;
          const extra = Object.entries(rest).map(([k, v]) => `${k}: ${v}`);
          sock.write(
            [
              'GET /graphql HTTP/1.1',
              `Host: ${host}`,
              'Upgrade: websocket',
              'Connection: Upgrade',
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
              'Sec-WebSocket-Version: 13',
              'Sec-WebSocket-Protocol: graphql-transport-ws',
              ...extra,
              '',
              '',
            ].join('\r\n'),
          );
        },
        data(sock, chunk) {
          buf += chunk.toString();
          if (buf.includes('\r\n')) {
            resolve(Number(buf.split(' ')[1]));
            sock.end();
          }
        },
        error(_s, e) {
          reject(e);
        },
      },
    }).catch(reject);
  });
}
