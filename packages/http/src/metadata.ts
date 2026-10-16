import { MetadataKey } from '@knead-js/core';
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

export const CONTROLLER = new MetadataKey<ControllerDefinition>('knead:controller');
export const ROUTES = new MetadataKey<RouteDefinition[]>('knead:routes');
export const GUARDS = new MetadataKey<GuardRef<any>[]>('knead:guards');
export const MIDDLEWARE = new MetadataKey<MiddlewareRef[]>('knead:middleware');
export const FILTERS = new MetadataKey<FilterRef[]>('knead:filters');
export const ROUTE_META = new MetadataKey<Record<PropertyKey, unknown>>('knead:route-meta');
export const CATCH = new MetadataKey<ErrorType[]>('knead:catch');
export const MODULE_MIDDLEWARE = new MetadataKey<MiddlewareRef[]>('knead:module-middleware');
