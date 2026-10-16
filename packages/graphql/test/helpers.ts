import type { ModuleImport, Provider } from '@hpmws/core';
import { Test, type TestApp, type TestingModule } from '@hpmws/testing';
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

/** Boots an app with GraphQLModule.forRoot(options) plus `imports`, listening on a random port. */
export async function startGraphQL(
  imports: ModuleImport[],
  options: GraphQLModuleOptions = {},
  providers: Provider[] = [],
): Promise<Started> {
  const mod = await Test.createModule({
    imports: [GraphQLModule.forRoot(options), ...imports],
    providers,
  }).compile({ development: false });
  const app = await mod.createApp();
  return { mod, app };
}

/** Bootstraps without listening and returns the sorted SDL. */
export async function sdlOf(
  imports: ModuleImport[],
  options: GraphQLModuleOptions = {},
): Promise<string> {
  const mod = await Test.createModule({
    imports: [GraphQLModule.forRoot(options), ...imports],
  }).compile();
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
