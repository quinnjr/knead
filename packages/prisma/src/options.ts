import { KneadError } from '@knead-js/core';
import type { PrismaModuleOptions, RegisteredClient } from './types.js';

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
  if (hasInstance) assertClient(o.instance);
  if (o.disconnectOnShutdown !== undefined && typeof o.disconnectOnShutdown !== 'boolean') {
    throw new KneadError('PrismaModule `disconnectOnShutdown` must be a boolean.');
  }
}

/** Throws a KneadError unless `client` has the `$connect`, `$disconnect` and `$transaction` methods. */
export function assertClient(client: unknown): asserts client is RegisteredClient {
  const c = client as Record<string, unknown> | null | undefined;
  for (const method of ['$connect', '$disconnect', '$transaction']) {
    if (typeof c !== 'object' || c === null || typeof c[method] !== 'function') {
      throw new KneadError(
        `PrismaModule client must be a Prisma client with a ${method}() method.`,
      );
    }
  }
}
