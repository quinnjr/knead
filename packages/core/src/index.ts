import './polyfill.js';
import './copy-guard.js';

export { ApplicationContext, type CreateContextOptions } from './application-context.js';
export * from './decorators.js';
export { type ErrorLogOptions, logError } from './error-log.js';
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
  errorText,
  escapeControl,
  isPlainObject,
  LOGGED_MESSAGE_LENGTH,
  logValue,
  MAX_LOGGED_VALUE_LENGTH,
  redactCredentials,
  redactValue,
  summarizeError,
} from './log-redaction.js';
export {
  ConsoleLogger,
  DeferredLogger,
  LOGGER,
  type LogEntry,
  type Logger,
  type LogLevel,
  MemoryLogger,
  type WarnLogger,
} from './logger.js';
export * from './metadata.js';
export { MODULES, type ModuleRef } from './modules.js';
export {
  defaultRedisUrl,
  isLoopbackHostname,
  parseIp,
  plaintextRedisHost,
  sendRedisCommand,
} from './net.js';
export * from './providers.js';
export * from './tokens.js';
