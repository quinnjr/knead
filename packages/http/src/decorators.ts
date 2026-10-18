import {
  appendMetadata,
  appendMethodMetadata,
  type MetadataKey,
  markInjectable,
  readMetadata,
  readMethodMetadata,
  setMetadata,
  setMethodMetadata,
} from '@knead-js/core';
import {
  CATCH,
  CONTROLLER,
  FILTERS,
  GUARDS,
  MIDDLEWARE,
  MODULE_MIDDLEWARE,
  ROUTE_META,
  ROUTES,
} from './metadata.js';
import type {
  ControllerOptions,
  ErrorType,
  FilterRef,
  GuardRef,
  HttpMethod,
  MiddlewareRef,
  RouteDecorator,
  RouteOptions,
} from './types.js';

export type ClassOrMethodDecorator = (
  target: unknown,
  context: ClassDecoratorContext | ClassMethodDecoratorContext,
) => void;

export function Controller(prefix = '', options: ControllerOptions = {}) {
  return (_target: Function, context: ClassDecoratorContext): void => {
    markInjectable(context.metadata);
    setMetadata(context.metadata, CONTROLLER, { prefix, options });
  };
}

function route(methods: readonly HttpMethod[], label: string) {
  return <const P extends string, const O extends RouteOptions = {}>(
    path: P,
    options?: O,
  ): RouteDecorator<P, O> =>
    (_method, context) => {
      if (context.static || context.private) {
        throw new TypeError(
          `@${label}() cannot decorate static or private method ${String(context.name)}.`,
        );
      }
      appendMetadata(context.metadata, ROUTES, {
        methods: [...methods],
        path,
        handler: context.name,
        options: (options ?? {}) as RouteOptions,
      });
    };
}

export const Get = route(['GET'], 'Get');
export const Post = route(['POST'], 'Post');
export const Put = route(['PUT'], 'Put');
export const Patch = route(['PATCH'], 'Patch');
export const Delete = route(['DELETE'], 'Delete');
export const Head = route(['HEAD'], 'Head');
export const Options = route(['OPTIONS'], 'Options');
/** GET, POST, PUT, PATCH, DELETE and OPTIONS. HEAD is answered by GET. */
export const All = route(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], 'All');

function classOrMethodList<T>(key: MetadataKey<T[]>, items: T[]): ClassOrMethodDecorator {
  return (_target, context) => {
    if (context.kind === 'class') appendMetadata(context.metadata, key, ...items);
    else appendMethodMetadata(context.metadata, context.name, key, ...items);
  };
}

export function UseGuards(...guards: GuardRef<any>[]): ClassOrMethodDecorator {
  return classOrMethodList(GUARDS, guards);
}

export function UseMiddleware(...middleware: MiddlewareRef[]): ClassOrMethodDecorator {
  return classOrMethodList(MIDDLEWARE, middleware);
}

export function UseFilters(...filters: FilterRef[]): ClassOrMethodDecorator {
  return classOrMethodList(FILTERS, filters);
}

/** Restricts an exception filter to errors of the given classes; marks it injectable. */
export function Catch(...errors: ErrorType[]) {
  return (_target: Function, context: ClassDecoratorContext): void => {
    markInjectable(context.metadata);
    setMetadata(context.metadata, CATCH, errors);
  };
}

/** Applies middleware to every controller declared in the decorated module. */
export function ModuleMiddleware(...middleware: MiddlewareRef[]) {
  return (_target: Function, context: ClassDecoratorContext): void => {
    appendMetadata(context.metadata, MODULE_MIDDLEWARE, ...middleware);
  };
}

/** Creates a decorator that writes `{ [key]: value }` into route metadata (`ctx.route.meta`). */
export function createRouteDecorator<T>(key: PropertyKey): (value: T) => ClassOrMethodDecorator {
  return (value) => (_target, context) => {
    if (context.kind === 'class') {
      const current = readMetadata(context.metadata, ROUTE_META) ?? {};
      setMetadata(context.metadata, ROUTE_META, { ...current, [key]: value });
    } else {
      const current = readMethodMetadata(context.metadata, context.name, ROUTE_META) ?? {};
      setMethodMetadata(context.metadata, context.name, ROUTE_META, { ...current, [key]: value });
    }
  };
}
