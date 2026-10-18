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
import type {
  ExceptionFilter,
  Guard,
  HttpMethod,
  Middleware,
  RouteInfo,
  UpgradeInfo,
} from './types.js';
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

/** A WebSocket handshake: a GET (RFC 6455) with `Upgrade: websocket`. */
function isUpgrade(req: Request): boolean {
  return req.method === 'GET' && req.headers.get('upgrade')?.toLowerCase() === 'websocket';
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
      // Fail closed: a missing return (undefined) rejects like false. `null` or `{}` is "no data".
      if (data === false || data === undefined) {
        throw new ForbiddenException('WebSocket upgrade rejected');
      }
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

/**
 * The `ctx.meta` of an upgrade to `path`: the endpoint's meta merged over `route`'s, or undefined
 * when the endpoint has none (ctx.meta is then the route's). Computed once per (path, route).
 */
function upgradeMeta(
  registry: WsRegistry,
  path: string,
  route: RouteInfo | null,
): Readonly<Record<PropertyKey, unknown>> | undefined {
  const endpointMeta = registry.meta(path);
  return endpointMeta && Object.freeze({ ...route?.meta, ...endpointMeta });
}

/** What runUpgrade() needs about one endpoint, as reached through one route (or none). */
interface UpgradeTarget {
  readonly path: string;
  readonly handler: Handler;
  readonly route: RouteInfo | null;
  readonly info: UpgradeInfo;
  readonly meta: Readonly<Record<PropertyKey, unknown>> | undefined;
}

function upgradeTarget(
  registry: WsRegistry,
  path: string,
  handler: Handler,
  route: RouteInfo | null,
): UpgradeTarget {
  const meta = upgradeMeta(registry, path, route);
  return { path, handler, route, info: Object.freeze({ path }), meta };
}

async function runUpgrade(
  registry: WsRegistry,
  target: UpgradeTarget,
  req: Request,
  server: Server<any>,
  net: NetConfig,
): Promise<Response | undefined> {
  const { handler, route, info, meta } = target;
  const ctx = new RequestContext(req, server, route, net, info, meta);
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

/**
 * `res` with `cacheControl` as its Cache-Control when it has none and `cacheControl` is set. The
 * header is set in place; a response whose headers cannot be changed is re-wrapped.
 */
export function withCacheControl(res: Response, cacheControl: string | undefined): Response {
  if (cacheControl === undefined || res.headers.has('cache-control')) return res;
  try {
    res.headers.set('cache-control', cacheControl);
    return res;
  } catch {
    return withHeaders(res, { 'cache-control': cacheControl });
  }
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
  /** Gives every answer of `handler` the default Cache-Control (an accepted upgrade has none). */
  const withCacheDefault = (handler: BunHandler): BunHandler =>
    cacheControl === undefined
      ? handler
      : async (req, server) => {
          const res = await handler(req, server);
          return res === undefined ? res : withCacheControl(res, cacheControl);
        };
  const checkForwarded = forwardedWarning(net, logger);
  const globalOnError = createErrorHandler(input.globalFilters, logger, development);
  const routes: CompiledApp['routes'] = {};
  const table: RouteTableEntry[] = [];
  const owners = new Map<string, string>();
  const shapes = new Map<string, string>();
  const allowed = new Map<string, Set<HttpMethod>>();
  // Bun hands WebSocket handshakes for a root "/*" route to fetch instead of the route, so one
  // without an endpoint is dispatched to that route from fetch: an ordinary GET, as without the
  // header.
  let rootWildcard: BunHandler | undefined;

  const wsTargets = new Map<string, UpgradeTarget>();
  /** Upgrades a handshake to the endpoint on its exact path; null when that path has none. */
  const upgradeEndpoint = async (req: Request, server: Server<any>) => {
    const target = wsTargets.get(requestPathname(req));
    return target ? runUpgrade(input.ws, target, req, server, net) : null;
  };
  for (const [path, endpoint] of input.ws.entries()) {
    const handler = upgradeChain(
      path,
      endpoint,
      input.ws,
      input.globalMiddleware,
      input.globalGuards,
      globalOnError,
    );
    wsTargets.set(path, upgradeTarget(input.ws, path, handler, null));
  }

  for (const mod of input.modules) {
    const injector = mod.injector;
    const moduleMw = (getOwnMetadata(mod.metatype, MODULE_MIDDLEWARE) ?? []).map((r) =>
      resolveMiddleware(r, injector, `the middleware of ${mod.name}`),
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
      ].map((r) => resolveMiddleware(r, injector, `the middleware of ${controller.name}`));
      const ctrlGuards = [
        ...(def.options.guards ?? []),
        ...(getMetadata(controller, GUARDS) ?? []),
      ].map((r) => resolveGuard(r, injector, `the guards of ${controller.name}`));
      const ctrlFilters = [
        ...(def.options.filters ?? []),
        ...(getMetadata(controller, FILTERS) ?? []),
      ].map((r) => resolveFilter(r, injector, `the filters of ${controller.name}`));
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
        ].map((r) => resolveMiddleware(r, injector, `the middleware of ${label}`));
        const routeGuards = [
          ...(route.options.guards ?? []),
          ...(getMethodMetadata(controller, name, GUARDS) ?? []),
        ].map((r) => resolveGuard(r, injector, `the guards of ${label}`));
        const routeFilters = [
          ...(route.options.filters ?? []),
          ...(getMethodMetadata(controller, name, FILTERS) ?? []),
        ].map((r) => resolveFilter(r, injector, `the filters of ${label}`));
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
            ? upgradeTarget(
                input.ws,
                path,
                upgradeChain(path, endpoint, input.ws, chain, [...guards, ...authorize], onError),
                info,
              )
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
          const dispatch: BunHandler = async (req, server) => {
            if (misdirected(req)) return misdirectedResponse();
            checkForwarded(req);
            if (ws && isUpgrade(req)) return runUpgrade(input.ws, ws, req, server, net);
            if (covers && isUpgrade(req)) {
              const upgraded = await upgradeEndpoint(req, server);
              if (upgraded !== null) return upgraded;
            }
            return handle(new RequestContext(req, server, info, net));
          };
          if (path === '/*' && method === 'GET') rootWildcard = dispatch;
          byMethod[method] = withCacheDefault(dispatch);
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
  const fetch: BunHandler = withCacheDefault(async (req, server) => {
    if (misdirected(req)) return misdirectedResponse();
    checkForwarded(req);
    if (isUpgrade(req)) {
      const upgraded = await upgradeEndpoint(req, server);
      if (upgraded !== null) return upgraded;
      if (rootWildcard) return rootWildcard(req, server);
    }
    return fallback(new RequestContext(req, server, null, net));
  });

  return { routes, fetch, table };
}
