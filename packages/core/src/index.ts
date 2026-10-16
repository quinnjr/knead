import './polyfill.js';
import './copy-guard.js';

export { ApplicationContext, type CreateContextOptions } from './application-context.js';
export * from './decorators.js';
export {
  CircularDependencyError,
  HpmwsError,
  InjectionContextError,
  ModuleDefinitionError,
  NoProviderError,
  ProviderConfigError,
} from './errors.js';
export * from './injection-context.js';
export { ModuleInjector } from './injector.js';
export type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from './lifecycle.js';
export * from './metadata.js';
export { MODULES, type ModuleRef } from './modules.js';
export * from './providers.js';
export * from './tokens.js';
