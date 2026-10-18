import { MetadataKey, readMetadata, setMetadata } from './metadata.js';
import { checkScope } from './provider-checks.js';
import type { Provider, Scope } from './providers.js';
import type { Token, Type } from './tokens.js';

export interface InjectableOptions {
  scope?: Scope;
}

export const INJECTABLE = new MetadataKey<{ scope: Scope }>('knead:injectable');

/**
 * Marks a class as a provider the container may construct (`providers: [Cls]`, `useClass: Cls`).
 * Required: an unmarked provider class fails at bootstrap. Subclasses of a marked class are
 * marked too and inherit its scope. Guards, middleware and filters do not need it.
 */
export function Injectable(options: InjectableOptions = {}) {
  const scope =
    options.scope === undefined ? 'singleton' : checkScope(options.scope, '@Injectable()');
  return (_target: Function, context: ClassDecoratorContext): void => {
    setMetadata(context.metadata, INJECTABLE, { scope });
  };
}

/**
 * Marks a class as injectable from another class decorator (`@Controller`, `@Resolver`,
 * `@Catch`), keeping a scope already set by `@Injectable` or a parent class.
 */
export function markInjectable(metadata: DecoratorMetadataObject): void {
  if (readMetadata(metadata, INJECTABLE) === undefined) {
    setMetadata(metadata, INJECTABLE, { scope: 'singleton' });
  }
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

export const MODULE_METADATA = new MetadataKey<ModuleOptions>('knead:module');

export function Module(options: ModuleOptions = {}) {
  return (_target: Function, context: ClassDecoratorContext): void => {
    setMetadata(context.metadata, MODULE_METADATA, options);
  };
}
