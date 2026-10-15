import type { AbstractType, Type } from '@hpmws/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Server } from 'bun';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * Augment to type `ctx.state`:
 * `declare module '@hpmws/http' { interface CtxState { user?: User } }`
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation point
export interface CtxState {}

export interface RouteInfo {
  readonly method: HttpMethod;
  readonly path: string;
  readonly controller: Type;
  readonly handler: string | symbol;
  readonly meta: Readonly<Record<PropertyKey, unknown>>;
}

export interface ResponseDraft {
  status: number | undefined;
  readonly headers: Headers;
}

export interface CtxInput {
  params?: unknown;
  query?: unknown;
  body?: unknown;
  headers?: unknown;
}

export interface Ctx<I extends CtxInput = {}> {
  readonly req: Request;
  params: I extends { params: infer P } ? P : Record<string, string>;
  query: I extends { query: infer Q } ? Q : Record<string, string | string[]>;
  body: I extends { body: infer B } ? B : unknown;
  headers: I extends { headers: infer H } ? H : Record<string, string>;
  /** Client IP, honouring `trustProxy`. */
  readonly ip: string | undefined;
  /** TLS listener, or a trusted proxy reported `X-Forwarded-Proto: https`. */
  readonly secure: boolean;
  /** Matched route; `null` for unmatched requests handled by the fallback. */
  readonly route: RouteInfo | null;
  readonly state: CtxState & Record<PropertyKey, unknown>;
  readonly res: ResponseDraft;
  readonly server: Server<any>;
  /** Parses the body by Content-Type (memoized). */
  json<T = unknown>(): Promise<T>;
}

type Simplify<T> = { [K in keyof T]: T[K] };
type ParamKeys<P extends string> = P extends `${string}:${infer K}/${infer R}`
  ? K | ParamKeys<`/${R}`>
  : P extends `${string}:${infer K}`
    ? K
    : never;
export type PathParams<P extends string> = Simplify<{ [K in ParamKeys<P>]: string }>;

export type Next = () => Promise<Response>;

export interface Middleware {
  use(ctx: Ctx, next: Next): Response | Promise<Response>;
}
export type MiddlewareFn = (ctx: Ctx, next: Next) => Response | Promise<Response>;
export type MiddlewareRef = Type<Middleware> | Middleware | MiddlewareFn;

export interface Guard<C = Ctx> {
  canActivate(ctx: C): boolean | Promise<boolean>;
}
export type GuardFn<C = Ctx> = (ctx: C) => boolean | Promise<boolean>;
export type GuardRef<C = Ctx> = Type<Guard<C>> | Guard<C> | GuardFn<C>;

export interface ExceptionFilter<E = unknown> {
  catch(error: E, ctx: Ctx): Response | Promise<Response>;
}
export type FilterRef = Type<ExceptionFilter<any>> | ExceptionFilter<any>;

export interface GlobalMiddleware {
  middleware: MiddlewareRef;
  /** Higher runs first (outermost). Default 0. */
  priority?: number;
}

export type ErrorType = AbstractType<unknown>;

export interface ControllerOptions {
  middleware?: MiddlewareRef[];
  guards?: GuardRef<any>[];
  filters?: FilterRef[];
  meta?: Record<PropertyKey, unknown>;
}

export interface RouteOptions extends ControllerOptions {
  params?: StandardSchemaV1;
  query?: StandardSchemaV1;
  body?: StandardSchemaV1;
  headers?: StandardSchemaV1;
  status?: number;
}

type SchemaOut<O, K extends string, D> = O extends { [P in K]: infer S }
  ? S extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<S>
    : D
  : D;

export type RouteInput<P extends string, O> = {
  params: SchemaOut<O, 'params', PathParams<P>>;
  query: SchemaOut<O, 'query', Record<string, string | string[]>>;
  body: SchemaOut<O, 'body', undefined>;
  headers: SchemaOut<O, 'headers', Record<string, string>>;
};

export type RouteDecorator<P extends string, O> = <
  This,
  F extends (this: This, ctx: Ctx<RouteInput<P, O>>) => unknown,
>(
  method: F,
  context: ClassMethodDecoratorContext<This, F>,
) => void;
