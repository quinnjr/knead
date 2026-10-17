import {
  type DynamicModule,
  inject,
  KneadError,
  Module,
  type ModuleImport,
  type Provider,
} from '@knead-js/core';
import { assertClient, assertOptions, isFactoryOptions } from './options.js';
import { PrismaService } from './prisma.service.js';
import { PRISMA_CLIENT, PRISMA_OPTIONS } from './tokens.js';
import { TransactionHost } from './transaction-host.js';
import type { PrismaModuleOptions } from './types.js';

export interface PrismaModuleAsyncOptions {
  imports?: ModuleImport[];
  useFactory: () => PrismaModuleOptions | Promise<PrismaModuleOptions>;
}

/** Checks the shape forRootAsync() needs; the factory's result is validated at bootstrap. */
function assertAsyncOptions(options: unknown): asserts options is PrismaModuleAsyncOptions {
  if (typeof options !== 'object' || options === null) {
    throw new KneadError('PrismaModule.forRootAsync() options must be an object.');
  }
  const { useFactory, imports } = options as { useFactory?: unknown; imports?: unknown };
  if (typeof useFactory !== 'function') {
    throw new KneadError('PrismaModule.forRootAsync() `useFactory` must be a function.');
  }
  if (imports !== undefined && !Array.isArray(imports)) {
    throw new KneadError('PrismaModule.forRootAsync() `imports` must be an array.');
  }
}

@Module({})
export class PrismaModule {
  static forRoot(options: PrismaModuleOptions): DynamicModule {
    assertOptions(options);
    return PrismaModule.#define([{ provide: PRISMA_OPTIONS, useValue: options }]);
  }

  static forRootAsync(options: PrismaModuleAsyncOptions): DynamicModule {
    assertAsyncOptions(options);
    return PrismaModule.#define(
      [
        {
          provide: PRISMA_OPTIONS,
          useFactory: async () => {
            const resolved = await options.useFactory();
            assertOptions(resolved);
            return resolved;
          },
        },
      ],
      options.imports,
    );
  }

  static #define(providers: Provider[], imports: ModuleImport[] = []): DynamicModule {
    return {
      module: PrismaModule,
      global: true,
      imports,
      providers: [
        ...providers,
        {
          provide: PRISMA_CLIENT,
          useFactory: async () => {
            const options = inject(PRISMA_OPTIONS);
            const client: unknown = isFactoryOptions(options)
              ? await options.client()
              : options.instance;
            assertClient(client);
            return client;
          },
        },
        PrismaService,
        TransactionHost,
      ],
      exports: [PrismaService, TransactionHost, PRISMA_CLIENT],
    };
  }
}
