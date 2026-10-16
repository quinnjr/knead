import { KneadError } from '@knead-js/core';
import type { PrismaModuleOptions } from './types.js';

/** Throws a KneadError unless `options` is a valid PrismaModuleOptions. */
export function assertOptions(options: unknown): asserts options is PrismaModuleOptions {
  if (typeof options !== 'object' || options === null) {
    throw new KneadError('PrismaModule options must be an object with `client` or `instance`.');
  }
  const o = options as { client?: unknown; instance?: unknown; disconnectOnShutdown?: unknown };
  const hasClient = o.client !== undefined;
  const hasInstance = o.instance !== undefined;
  if (hasClient === hasInstance) {
    throw new KneadError('PrismaModule options need exactly one of `client` or `instance`.');
  }
  if (hasClient && typeof o.client !== 'function') {
    throw new KneadError('PrismaModule `client` must be a function returning a Prisma client.');
  }
  if (hasInstance && (typeof o.instance !== 'object' || o.instance === null)) {
    throw new KneadError('PrismaModule `instance` must be a Prisma client.');
  }
  if (o.disconnectOnShutdown !== undefined && typeof o.disconnectOnShutdown !== 'boolean') {
    throw new KneadError('PrismaModule `disconnectOnShutdown` must be a boolean.');
  }
}
