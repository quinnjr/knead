import { getMetadata, getMethodMetadata, getOwnMetadata, type ModuleRef } from '@hpmws/core';
import type { Server } from 'bun';
import { type NetConfig, RequestContext } from './context.js';
import {
  BadRequestException,
  ForbiddenException,
  HttpConfigError,
  MethodNotAllowedException,
  NotFoundException,
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
import { compileMatcher, joinPaths, routeShape } from './path.js';
import {
  composeMiddleware,
  createErrorHandler,
  type ErrorHandler,
  type Handler,
  runGuards,
} from './pipeline.js';
import { resolveFilter, resolveGuard, resolveMiddleware } from './resolve.js';
import { toResponse } from './response.js';
import type { ExceptionFilter, Guard, HttpMethod, Middleware, RouteInfo } from './types.js';
import { validateRequest } from './validation.js';
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

function upgradeChain(
  path: string,
  endpoint: WsEndpoint,
  globalMiddleware: readonly Middleware[],
  onError: ErrorHandler,
): Handler {
  const terminal: Handler = async (ctx) => {
    try {
      const data = await endpoint.upgrade(ctx);
      if (data === false) throw new ForbiddenException('WebSocket upgrade rejected');
      const accepted = (ctx.server as Server<WsData>).upgrade(ctx.req, {
        data: { endpoint: path, data },
      });
      if (!accepted) throw new BadRequestException('WebSocket upgrade failed');
      upgraded.add(ctx);
      return new Response(null, { status: 101 });
    } catch (error) {
      return onError(error, ctx);
    }
  };
  return composeMiddleware(globalMiddleware, terminal, onError);
}

async function runUpgrade(
  handler: Handler,
  req: Request,
  server: Server<any>,
  net: NetConfig,
): Promise<Response | undefined> {
  const ctx = new RequestContext(req, server, null, net);
  const res = await handler(ctx);
  return upgraded.has(ctx) ? undefined : res;
}

export function compileApplication(input: CompileInput): CompiledApp {
  const { logger, development, net } = input;
  const globalOnError = createErrorHandler(input.globalFilters, logger, development);
  const routes: CompiledApp['routes'] = {};
  const table: RouteTableEntry[] = [];
  const owners = new Map<string, string>();
  const shapes = new Map<string, string>();
  const allowed = new Map<string, { matcher: RegExp; methods: Set<HttpMethod> }>();

  input.ws.seal();
  const wsHandlers = new Map<string, Handler>();
  for (const [path, endpoint] of input.ws.entries()) {
    wsHandlers.set(path, upgradeChain(path, endpoint, input.globalMiddleware, globalOnError));
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
      ].map((r) => resolveGuard(r, injector));
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
        ].map((r) => resolveGuard(r, injector));
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
              await validateRequest(ctx, route.options);
              const result = await (fn as (c: unknown) => unknown).call(instance, ctx);
              return toResponse(result, ctx.res.status ?? route.options.status, ctx.res.headers);
            } catch (error) {
              return onError(error, ctx);
            }
          };
          const handle = composeMiddleware(chain, terminal, onError);
          const ws = method === 'GET' ? wsHandlers.get(path) : undefined;
          let byMethod = routes[path];
          if (!byMethod) {
            byMethod = {};
            routes[path] = byMethod;
          }
          byMethod[method] = async (req, server) => {
            if (ws && isUpgrade(req)) return runUpgrade(ws, req, server, net);
            return handle(new RequestContext(req, server, info, net));
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
      const pathname = new URL(ctx.req.url).pathname;
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
    if (isUpgrade(req)) {
      const ws = wsHandlers.get(new URL(req.url).pathname);
      if (ws) return runUpgrade(ws, req, server, net);
    }
    return fallback(new RequestContext(req, server, null, net));
  };

  return { routes, fetch, table };
}
