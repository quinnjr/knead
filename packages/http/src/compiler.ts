import { getMetadata, getMethodMetadata, getOwnMetadata, type ModuleRef } from '@hpmws/core';
import type { Server } from 'bun';
import { type NetConfig, RequestContext } from './context.js';
import {
  BadRequestException,
  ForbiddenException,
  HttpConfigError,
  MethodNotAllowedException,
  NotFoundException,
  problemResponse,
} from './exceptions.js';
import type { Logger } from './logger.js';
import {
  CONTROLLER,
  FILTERS,
  GUARDS,
  MIDDLEWARE,
  MODULE_MIDDLEWARE,
  ROUTE_META,
  ROUTES,
} from './metadata.js';
import type { HostMatcher } from './net.js';
import { compileMatcher, joinPaths, routeShape } from './path.js';
import {
  composeMiddleware,
  createErrorHandler,
  type ErrorHandler,
  type Handler,
  runGuards,
} from './pipeline.js';
import { requestUrl } from './request.js';
import { resolveFilter, resolveGuard, resolveMiddleware } from './resolve.js';
import { toResponse, withHeaders } from './response.js';
import type { ExceptionFilter, Guard, HttpMethod, Middleware, RouteInfo } from './types.js';
import { type ValidationOptions, validateRequest } from './validation.js';
import type { WsData, WsEndpoint, WsRegistry } from './ws.js';

export type BunHandler = (req: Request, server: Server<any>) => Promise<Response | undefined>;

export interface RouteTableEntry {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: string;
}

export interface CompileInput {
  readonly modules: readonly ModuleRef[];
  readonly globalMiddleware: readonly Middleware[];
  readonly globalGuards: readonly Guard<any>[];
  readonly globalFilters: readonly ExceptionFilter[];
  readonly logger: Logger;
  readonly development: boolean;
  readonly net: NetConfig;
  readonly ws: WsRegistry;
  readonly validation?: ValidationOptions | undefined;
  /** `listen({ defaultCacheControl })`: set on responses that have no Cache-Control. */
  readonly defaultCacheControl?: string | undefined;
  /** `listen({ allowedHosts })`: requests whose Host is not allowed get 421. */
  readonly hosts?: HostMatcher | undefined;
}

export interface CompiledApp {
  readonly routes: Record<string, Partial<Record<HttpMethod, BunHandler>>>;
  readonly fetch: BunHandler;
  readonly table: readonly RouteTableEntry[];
}

const upgraded = new WeakSet<RequestContext>();

function isUpgrade(req: Request): boolean {
  return req.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

/**
 * The handler of an upgrade to a WebSocket endpoint: `middleware` (global middleware, plus the
 * GET route's module, controller and route middleware when the path also has a GET route), then
 * the Origin check, `guards` (global, plus that route's controller and route guards), then the
 * endpoint's upgrade().
 */
function upgradeChain(
  path: string,
  endpoint: WsEndpoint,
  registry: WsRegistry,
  middleware: readonly Middleware[],
  guards: readonly Guard<any>[],
  onError: ErrorHandler,
): Handler {
  const terminal: Handler = async (ctx) => {
    try {
      registry.checkOrigin(path, ctx);
      // Guards protect upgrades like any route; ctx.route is the GET route sharing the path, if any.
      await runGuards(guards, ctx);
      const data = await endpoint.upgrade(ctx);
      if (data === false) throw new ForbiddenException('WebSocket upgrade rejected');
      const socketData: WsData = { endpoint: path, data, ip: ctx.ip };
      // Synchronous from here to upgrade(): the connection limits cannot be raced.
      registry.reserve(socketData, ctx.ip);
      let accepted = false;
      try {
        accepted = (ctx.server as Server<WsData>).upgrade(ctx.req, { data: socketData });
      } finally {
        if (!accepted) registry.release(socketData);
      }
      if (!accepted) throw new BadRequestException('WebSocket upgrade failed');
      upgraded.add(ctx);
      return new Response(null, { status: 101 });
    } catch (error) {
      return onError(error, ctx);
    }
  };
  return composeMiddleware(middleware, terminal, onError);
}

async function runUpgrade(
  path: string,
  handler: Handler,
  req: Request,
  server: Server<any>,
  net: NetConfig,
  route: RouteInfo | null = null,
): Promise<Response | undefined> {
  const ctx = new RequestContext(req, server, route, net, Object.freeze({ path }));
  const res = await handler(ctx);
  return upgraded.has(ctx) ? undefined : res;
}

const FORWARDED_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host'] as const;

/** Logs once when X-Forwarded-* arrives while trustProxy is off (likely a misconfigured proxy). */
function forwardedWarning(net: NetConfig, logger: Logger): (req: Request) => void {
  let warned = net.trust.kind !== 'none';
  return (req) => {
    if (warned || !FORWARDED_HEADERS.some((h) => req.headers.has(h))) return;
    warned = true;
    logger.warn(
      'A request carried X-Forwarded-* headers, but trustProxy is off, so they are ignored: ' +
        'ctx.ip and ctx.secure come from the socket. Behind a reverse proxy, set ' +
        'listen({ trustProxy }) to a hop count or the proxy CIDRs.',
    );
  };
}

/** The answer to a request whose Host is not in `allowedHosts` (DNS rebinding protection). */
export function misdirectedResponse(): Response {
  return problemResponse({
    type: 'about:blank',
    title: 'Misdirected Request',
    status: 421,
    detail: 'This server does not serve the requested host.',
  });
}

export function compileApplication(input: CompileInput): CompiledApp {
  const { logger, development, net, hosts } = input;
  const misdirected = (req: Request) => hosts !== undefined && !hosts(req.headers.get('host'));
  const cacheControl = input.defaultCacheControl;
  const withCacheDefault = (res: Response): Response =>
    cacheControl === undefined || res.headers.has('cache-control')
      ? res
      : withHeaders(res, { 'cache-control': cacheControl });
  const checkForwarded = forwardedWarning(net, logger);
  const globalOnError = createErrorHandler(input.globalFilters, logger, development);
  const routes: CompiledApp['routes'] = {};
  const table: RouteTableEntry[] = [];
  const owners = new Map<string, string>();
  const shapes = new Map<string, string>();
  const allowed = new Map<string, { matcher: RegExp; methods: Set<HttpMethod> }>();

  const wsHandlers = new Map<string, Handler>();
  for (const [path, endpoint] of input.ws.entries()) {
    wsHandlers.set(
      path,
      upgradeChain(
        path,
        endpoint,
        input.ws,
        input.globalMiddleware,
        input.globalGuards,
        globalOnError,
      ),
    );
  }

  for (const mod of input.modules) {
    const injector = mod.injector;
    const moduleMw = (getOwnMetadata(mod.metatype, MODULE_MIDDLEWARE) ?? []).map((r) =>
      resolveMiddleware(r, injector),
    );
    for (const controller of mod.controllers) {
      const def = getOwnMetadata(controller, CONTROLLER);
      if (!def) {
        throw new HttpConfigError(
          `${controller.name} is listed in ${mod.name}.controllers but is not decorated with @Controller().`,
        );
      }
      const instance = injector.get(controller) as Record<PropertyKey, unknown>;
      const ctrlMw = [
        ...(def.options.middleware ?? []),
        ...(getMetadata(controller, MIDDLEWARE) ?? []),
      ].map((r) => resolveMiddleware(r, injector));
      const ctrlGuards = [
        ...(def.options.guards ?? []),
        ...(getMetadata(controller, GUARDS) ?? []),
      ].map((r) => resolveGuard(r, injector, `the guards of ${controller.name}`));
      const ctrlFilters = [
        ...(def.options.filters ?? []),
        ...(getMetadata(controller, FILTERS) ?? []),
      ].map((r) => resolveFilter(r, injector));
      const ctrlMeta = {
        ...(def.options.meta ?? {}),
        ...(getMetadata(controller, ROUTE_META) ?? {}),
      };

      for (const route of getMetadata(controller, ROUTES) ?? []) {
        const name = route.handler;
        const label = `${controller.name}.${String(name)}`;
        const fn = instance[name];
        if (typeof fn !== 'function') throw new HttpConfigError(`${label} is not a method.`);
        const path = joinPaths(def.prefix, route.path);
        if (path.split('*').length > 2) {
          throw new HttpConfigError(`Route ${path} has more than one "*" wildcard (${label}).`);
        }
        const shape = routeShape(path);
        const known = shapes.get(shape);
        if (known !== undefined && known !== path) {
          throw new HttpConfigError(
            `Routes ${known} and ${path} differ only in parameter names; use the same names (${label}).`,
          );
        }
        shapes.set(shape, path);

        const routeMw = [
          ...(route.options.middleware ?? []),
          ...(getMethodMetadata(controller, name, MIDDLEWARE) ?? []),
        ].map((r) => resolveMiddleware(r, injector));
        const routeGuards = [
          ...(route.options.guards ?? []),
          ...(getMethodMetadata(controller, name, GUARDS) ?? []),
        ].map((r) => resolveGuard(r, injector, `the guards of ${label}`));
        const routeFilters = [
          ...(route.options.filters ?? []),
          ...(getMethodMetadata(controller, name, FILTERS) ?? []),
        ].map((r) => resolveFilter(r, injector));
        const meta = Object.freeze({
          ...ctrlMeta,
          ...(route.options.meta ?? {}),
          ...(getMethodMetadata(controller, name, ROUTE_META) ?? {}),
        });
        const guards = [...input.globalGuards, ...ctrlGuards, ...routeGuards];
        const authorize = (route.options.authorize ?? []).map((r) =>
          resolveGuard(r, injector, `the authorize guards of ${label}`),
        );
        const onError = createErrorHandler(
          [...routeFilters, ...ctrlFilters, ...input.globalFilters],
          logger,
          development,
        );
        const chain = [...input.globalMiddleware, ...moduleMw, ...ctrlMw, ...routeMw];

        for (const method of route.methods) {
          const key = `${method} ${shape}`;
          const previous = owners.get(key);
          if (previous)
            throw new HttpConfigError(
              `Duplicate route ${method} ${path}: ${previous} and ${label}.`,
            );
          owners.set(key, label);
          const info: RouteInfo = Object.freeze({ method, path, controller, handler: name, meta });
          const terminal: Handler = async (ctx) => {
            try {
              await runGuards(guards, ctx);
              await validateRequest(ctx, route.options, input.validation);
              // Authorization that depends on the validated (canonical) input.
              await runGuards(authorize, ctx);
              const result = await (fn as (c: unknown) => unknown).call(instance, ctx);
              return toResponse(result, ctx.res.status ?? route.options.status, ctx.res.headers);
            } catch (error) {
              return onError(error, ctx);
            }
          };
          const handle = composeMiddleware(chain, terminal, onError);
          // A WebSocket endpoint on the path of a GET route: upgrades run that route's
          // middleware and guards too (secure by default), with ctx.route set to it.
          const endpoint = method === 'GET' ? input.ws.get(path) : undefined;
          const ws = endpoint
            ? upgradeChain(path, endpoint, input.ws, chain, guards, onError)
            : undefined;
          let byMethod = routes[path];
          if (!byMethod) {
            byMethod = {};
            routes[path] = byMethod;
          }
          byMethod[method] = async (req, server) => {
            if (misdirected(req)) return misdirectedResponse();
            checkForwarded(req);
            if (ws && isUpgrade(req)) return runUpgrade(path, ws, req, server, net, info);
            return withCacheDefault(await handle(new RequestContext(req, server, info, net)));
          };
          const entry = allowed.get(path) ?? {
            matcher: compileMatcher(path),
            methods: new Set<HttpMethod>(),
          };
          entry.methods.add(method);
          allowed.set(path, entry);
          table.push({ method, path, handler: label });
        }
      }
    }
  }

  const unmatched: Handler = async (ctx) => {
    try {
      const pathname = requestUrl(ctx.req).pathname;
      const methods = new Set<string>();
      for (const { matcher, methods: m } of allowed.values()) {
        if (matcher.test(pathname)) for (const x of m) methods.add(x);
      }
      if (methods.size > 0) {
        if (methods.has('GET')) methods.add('HEAD');
        throw new MethodNotAllowedException(`${ctx.req.method} is not allowed on ${pathname}`, {
          headers: { allow: [...methods].join(', ') },
        });
      }
      throw new NotFoundException(`No route for ${ctx.req.method} ${pathname}`);
    } catch (error) {
      return globalOnError(error, ctx);
    }
  };
  const fallback = composeMiddleware(input.globalMiddleware, unmatched, globalOnError);

  const fetch: BunHandler = async (req, server) => {
    if (misdirected(req)) return misdirectedResponse();
    checkForwarded(req);
    if (isUpgrade(req)) {
      const pathname = requestUrl(req).pathname;
      const ws = wsHandlers.get(pathname);
      if (ws) return runUpgrade(pathname, ws, req, server, net);
    }
    return withCacheDefault(await fallback(new RequestContext(req, server, null, net)));
  };

  return { routes, fetch, table };
}
