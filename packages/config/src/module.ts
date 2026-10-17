import { type DynamicModule, Module, type ModuleImport } from '@knead-js/core';
import type { ConfigHandle, ConfigSchema } from './define.js';
import { type ConfigSources, loadConfig } from './load.js';

export interface ConfigModuleAsyncOptions<S extends ConfigSchema> {
  imports?: ModuleImport[];
  /** Runs inside the injection context, so it may call `inject()`. Loaders may not. */
  useFactory: () => ConfigSources<S> | Promise<ConfigSources<S>>;
}

@Module({})
export class ConfigModule {
  static forRoot<S extends ConfigSchema>(
    handle: ConfigHandle<S>,
    sources?: ConfigSources<S>,
  ): DynamicModule {
    return ConfigModule.#define(handle, () => loadConfig(handle, sources));
  }

  static forRootAsync<S extends ConfigSchema>(
    handle: ConfigHandle<S>,
    options: ConfigModuleAsyncOptions<S>,
  ): DynamicModule {
    return ConfigModule.#define(
      handle,
      () => {
        // Called synchronously so inject() works and a core retry happens before any loader starts.
        const sources = options.useFactory();
        return Promise.resolve(sources).then((resolved) => loadConfig(handle, resolved));
      },
      options.imports,
    );
  }

  static #define<S extends ConfigSchema>(
    handle: ConfigHandle<S>,
    useFactory: () => Promise<unknown>,
    imports: ModuleImport[] = [],
  ): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      imports,
      providers: [{ provide: handle, useFactory }],
      exports: [handle],
    };
  }
}
