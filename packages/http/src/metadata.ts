import { MetadataKey } from '@hpmws/core';
import type {
  ControllerOptions,
  ErrorType,
  FilterRef,
  GuardRef,
  HttpMethod,
  MiddlewareRef,
  RouteOptions,
} from './types.js';

export interface ControllerDefinition {
  prefix: string;
  options: ControllerOptions;
}

export interface RouteDefinition {
  methods: HttpMethod[];
  path: string;
  handler: string | symbol;
  options: RouteOptions;
}

export const CONTROLLER = new MetadataKey<ControllerDefinition>('hpmws:controller');
export const ROUTES = new MetadataKey<RouteDefinition[]>('hpmws:routes');
export const GUARDS = new MetadataKey<GuardRef<any>[]>('hpmws:guards');
export const MIDDLEWARE = new MetadataKey<MiddlewareRef[]>('hpmws:middleware');
export const FILTERS = new MetadataKey<FilterRef[]>('hpmws:filters');
export const ROUTE_META = new MetadataKey<Record<PropertyKey, unknown>>('hpmws:route-meta');
export const CATCH = new MetadataKey<ErrorType[]>('hpmws:catch');
export const MODULE_MIDDLEWARE = new MetadataKey<MiddlewareRef[]>('hpmws:module-middleware');
