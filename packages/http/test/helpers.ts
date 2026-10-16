import type { ModuleImport } from '@knead/core';
import type { Server } from 'bun';
import {
  type CreateApplicationOptions,
  HpmwsFactory,
  type HttpApplication,
  type ListenOptions,
} from '../src/application.js';
import { type NetConfig, RequestContext } from '../src/context.js';
import { MemoryLogger } from '../src/logger.js';
import type { RouteInfo } from '../src/types.js';

export function fakeServer(address = '127.0.0.1'): Server<any> {
  return {
    requestIP: () => ({ address, family: address.includes(':') ? 'IPv6' : 'IPv4', port: 50000 }),
  } as unknown as Server<any>;
}

export function makeCtx(
  input: string | Request,
  options: { route?: RouteInfo | null; net?: Partial<NetConfig>; address?: string } = {},
): RequestContext {
  const req =
    typeof input === 'string' ? new Request(new URL(input, 'http://localhost').href) : input;
  const net: NetConfig = { trust: { kind: 'none' }, tls: false, ...options.net };
  return new RequestContext(req, fakeServer(options.address), options.route ?? null, net);
}

export async function start(
  root: ModuleImport,
  listen: ListenOptions = {},
  create: CreateApplicationOptions = {},
): Promise<HttpApplication> {
  const app = await HpmwsFactory.create(root, {
    logger: new MemoryLogger(),
    development: false,
    ...create,
  });
  await app.listen({ port: 0, hostname: '127.0.0.1', ...listen });
  return app;
}
