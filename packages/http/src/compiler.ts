import { getMetadata, getMethodMetadata, getOwnMetadata, type ModuleRef } from '@knead-js/core';
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
import { type Logger, logValue } from './logger.js';
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
import { compilePathIndex, joinPaths, routeShape } from './path.js';
import {
  composeMiddleware,
  createErrorHandler,
  type ErrorHandler,
  type Handler,
  runGuards,
} from './pipeline.js';
import { requestPathname } from './request.js';
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
      registry.reserve(socketData, ctx.ip, ctx);
      let accepted = false;
      try {
        // Headers set on ctx.res so far (by middleware before next(), guards or the endpoint)
        // go out with the 101. Bun writes the handshake here, so middleware that adds headers
        // to the returned response after next() cannot reach it.
        accepted = (ctx.server as Server<WsData>).upgrade(ctx.req, {
          data: socketData,
          headers: ctx.res.headers,
        });
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
  registry: WsRegistry,
  path: string,
  handler: Handler,
  req: Request,
  server: Server<any>,
  net: NetConfig,
  route: RouteInfo | null = null,
): Promise<Response | undefined> {
  const endpointMeta = registry.meta(path);
  const meta = endpointMeta && Object.freeze({ ...route?.meta, ...endpointMeta });
  const ctx = new RequestContext(req, server, route, net, Object.freeze({ path }), meta);
  registry.beginUpgrade(ctx);
  try {
    const res = await handler(ctx);
    return upgraded.has(ctx) ? undefined : res;
  } finally {
    // Still marked only when the upgrade did not reach its socket data.
    registry.endUpgrade(ctx);
  }
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
  const warnedHosts = new Set<string>();
  const misdirected = (req: Request) => {
    if (hosts === undefined) return false;
    const host = req.headers.get('host');
    if (hosts(host)) return false;
    // Once per distinct Host (bounded), so a misconfigured name is easy to spot.
    const name = host ?? '(none)';
    if (!warnedHosts.has(name) && warnedHosts.size < 100) {
      warnedHosts.add(name);
      logger.warn(
        `Rejected a request for Host ${JSON.stringify(logValue(name))} with 421: it is not in ` +
          'allowedHosts. If this server should answer to it, add it to listen({ allowedHosts }).',
      );
    }
    return true;
  };
  const cacheControl = input.defaultCacheControl;
  const withCacheDefault = (res: Response): Response =>
    cacheControl === undefined || res.headers.has('cache-control')
      ? res
      : withHeaders(res, { 'cache-control': cacheControl });
  /** A rejected upgrade's answer gets the default Cache-Control; an accepted one is undefined. */
  const upgradeResult = (res: Response | undefined) => res && withCacheDefault(res);
  const checkForwarded = forwardedWarning(net, logger);
  const globalOnError = createErrorHandler(input.globalFilters, logger, development);
  const routes: CompiledApp['routes'] = {};
  const table: RouteTableEntry[] = [];
  const owners = new Map<string, string>();
  const shapes = new Map<string, string>();
  const allowed = new Map<string, Set<HttpMethod>>();

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
        if (path.includes('*') && !path.endsWith('/*')) {
          throw new HttpConfigError(
            `Route ${path} has a "*" that is not the whole last segment (${label}); Bun only matches a trailing "/*".`,
          );
        }
        const status = route.options.status;
        if (status !== undefined && (!Number.isInteger(status) || status < 200 || status > 599)) {
          throw new HttpConfigError(
            `Route ${path} has status ${String(status)}; a route status must be an integer from 200 to 599 (${label}).`,
          );
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
          // Upgrades are not validated, so the route's authorize guards see the raw ctx there.
          const ws = endpoint
            ? upgradeChain(path, endpoint, input.ws, chain, [...guards, ...authorize], onError)
            : undefined;
          // A parametric or wildcard GET route can cover the exact path of an endpoint: its
          // upgrades go to that endpoint (global middleware and guards, ctx.route null), as if no
          // route matched, instead of being answered as an ordinary GET.
          const covers = method === 'GET' && !ws && (path.includes(':') || path.includes('*'));
          let byMethod = routes[path];
          if (!byMethod) {
            byMethod = {};
            routes[path] = byMethod;
          }
          byMethod[method] = async (req, server) => {
            if (misdirected(req)) return withCacheDefault(misdirectedResponse());
            checkForwarded(req);
            if (ws && isUpgrade(req)) {
              return upgradeResult(await runUpgrade(input.ws, path, ws, req, server, net, info));
            }
            if (covers && isUpgrade(req)) {
              const pathname = requestPathname(req);
              const covered = wsHandlers.get(pathname);
              if (covered) {
                return upgradeResult(
                  await runUpgrade(input.ws, pathname, covered, req, server, net),
                );
              }
            }
            return withCacheDefault(await handle(new RequestContext(req, server, info, net)));
          };
          const methods = allowed.get(path) ?? new Set<HttpMethod>();
          methods.add(method);
          allowed.set(path, methods);
          table.push({ method, path, handler: label });
        }
      }
    }
  }

  const allowedFor = compilePathIndex(allowed);
  const unmatched: Handler = async (ctx) => {
    try {
      const pathname = requestPathname(ctx.req);
      const methods = new Set<string>();
      for (const m of allowedFor(pathname)) for (const x of m) methods.add(x);
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
  // Bun hands WebSocket handshakes for a root "/*" route to fetch instead of the route, so one
  // without an endpoint is dispatched to that route here: an ordinary GET, as without the header.
  const rootWildcard = routes['/*']?.GET;

  const fetch: BunHandler = async (req, server) => {
    if (misdirected(req)) return withCacheDefault(misdirectedResponse());
    checkForwarded(req);
    if (isUpgrade(req)) {
      const pathname = requestPathname(req);
      const ws = wsHandlers.get(pathname);
      if (ws) return upgradeResult(await runUpgrade(input.ws, pathname, ws, req, server, net));
      if (rootWildcard) return rootWildcard(req, server);
    }
    return withCacheDefault(await fallback(new RequestContext(req, server, null, net)));
  };

  return { routes, fetch, table };
}
