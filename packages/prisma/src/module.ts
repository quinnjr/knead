import {
  type DynamicModule,
  inject,
  Module,
  type ModuleImport,
  type Provider,
} from '@knead-js/core';
import { assertClient, assertOptions } from './options.js';
import { PrismaService } from './prisma.service.js';
import { PRISMA_CLIENT, PRISMA_OPTIONS } from './tokens.js';
import type { PrismaModuleOptions } from './types.js';

export interface PrismaModuleAsyncOptions {
  imports?: ModuleImport[];
  useFactory: () => PrismaModuleOptions | Promise<PrismaModuleOptions>;
}

@Module({})
export class PrismaModule {
  static forRoot(options: PrismaModuleOptions): DynamicModule {
    assertOptions(options);
    return PrismaModule.#define([{ provide: PRISMA_OPTIONS, useValue: options }]);
  }

  static forRootAsync(options: PrismaModuleAsyncOptions): DynamicModule {
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
            const client =
              typeof (options as { client?: unknown }).client === 'function'
                ? await (options as { client: () => unknown }).client()
                : (options as { instance: unknown }).instance;
            assertClient(client);
            return client;
          },
        },
        PrismaService,
      ],
      exports: [PrismaService, PRISMA_CLIENT],
    };
  }
}
