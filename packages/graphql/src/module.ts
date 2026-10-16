import {
  type DynamicModule,
  inject,
  Module,
  type ModuleImport,
  type Provider,
} from '@knead-js/core';
import { HTTP_DEVELOPMENT, LOGGER } from '@knead-js/http';
import { PubSub } from '@leaven-graphql/ws';
import { createGraphQLController } from './http.js';
import {
  GRAPHQL_OPTIONS,
  GRAPHQL_PATH,
  type GraphQLModuleOptions,
  normalizePath,
  validateGraphQLOptions,
} from './options.js';
import { leavenLogger, PUBSUB } from './pubsub.js';
import { GraphQLRuntime } from './runtime.js';
import { GraphQLSubscriptions } from './subscriptions-service.js';

export interface GraphQLModuleAsyncOptions {
  /** Routes are compiled from decorators, so the path is static even for async options. */
  path?: string;
  imports?: ModuleImport[];
  useFactory: () =>
    | Omit<GraphQLModuleOptions, 'path'>
    | Promise<Omit<GraphQLModuleOptions, 'path'>>;
}

@Module({})
export class GraphQLModule {
  static forRoot(options: GraphQLModuleOptions = {}): DynamicModule {
    validateGraphQLOptions(options);
    return GraphQLModule.#define(options.path, [{ provide: GRAPHQL_OPTIONS, useValue: options }]);
  }

  static forRootAsync(options: GraphQLModuleAsyncOptions): DynamicModule {
    validateGraphQLOptions({ path: options.path });
    return GraphQLModule.#define(
      options.path,
      [{ provide: GRAPHQL_OPTIONS, useFactory: options.useFactory }],
      options.imports,
    );
  }

  static #define(
    path = '/graphql',
    providers: Provider[],
    imports: ModuleImport[] = [],
  ): DynamicModule {
    const normalized = normalizePath(path);
    return {
      module: GraphQLModule,
      global: true,
      imports,
      controllers: [createGraphQLController(normalized)],
      providers: [
        ...providers,
        { provide: GRAPHQL_PATH, useValue: normalized },
        {
          provide: PUBSUB,
          useFactory: () =>
            inject(GRAPHQL_OPTIONS).pubsub ??
            new PubSub({
              logger: leavenLogger(
                inject(LOGGER),
                inject(HTTP_DEVELOPMENT, { optional: true }) ??
                  process.env.NODE_ENV === 'development',
              ),
            }),
        },
        GraphQLRuntime,
        GraphQLSubscriptions,
      ],
      exports: [PUBSUB, GraphQLRuntime, GraphQLSubscriptions],
    };
  }
}
