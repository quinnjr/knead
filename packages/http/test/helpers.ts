import type { Server } from 'bun';
import { type NetConfig, RequestContext } from '../src/context.js';
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
