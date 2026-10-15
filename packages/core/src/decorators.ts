import { MetadataKey, setMetadata } from './metadata.js';
import type { Provider, Scope } from './providers.js';
import type { Token, Type } from './tokens.js';

export interface InjectableOptions {
  scope?: Scope;
}

export const INJECTABLE = new MetadataKey<{ scope: Scope }>('hpmws:injectable');

/** Optional: classes are injectable without it. Use it to set a scope. */
export function Injectable(options: InjectableOptions = {}) {
  return (_target: Function, context: ClassDecoratorContext): void => {
    setMetadata(context.metadata, INJECTABLE, { scope: options.scope ?? 'singleton' });
  };
}

export interface ModuleOptions {
  imports?: ModuleImport[];
  providers?: Provider[];
  controllers?: Type[];
  exports?: ModuleExport[];
  global?: boolean;
}

export interface DynamicModule extends ModuleOptions {
  module: Type;
}

export type ModuleImport = Type | DynamicModule;
export type ModuleExport = Token | ModuleImport;

export const MODULE_METADATA = new MetadataKey<ModuleOptions>('hpmws:module');

export function Module(options: ModuleOptions = {}) {
  return (_target: Function, context: ClassDecoratorContext): void => {
    setMetadata(context.metadata, MODULE_METADATA, options);
  };
}
