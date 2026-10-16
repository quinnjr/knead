import './polyfill.js';
import './copy-guard.js';

export { ApplicationContext, type CreateContextOptions } from './application-context.js';
export * from './decorators.js';
export {
  CircularDependencyError,
  InjectionContextError,
  KneadError,
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
export {
  escapeControl,
  LOGGED_MESSAGE_LENGTH,
  logValue,
  MAX_LOGGED_VALUE_LENGTH,
  redactCredentials,
  redactValue,
  summarizeError,
} from './log-redaction.js';
export * from './metadata.js';
export { MODULES, type ModuleRef } from './modules.js';
export { defaultRedisUrl, isLoopbackHostname, parseIp, plaintextRedisHost } from './net.js';
export * from './providers.js';
export * from './tokens.js';
