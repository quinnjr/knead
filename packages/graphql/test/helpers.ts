import type { ModuleImport, Provider } from '@hpmws/core';
import { Test, type TestApp, type TestingModule } from '@hpmws/testing';
import {
  GraphQLModule,
  type GraphQLModuleOptions,
  GraphQLRuntime,
  printSortedSchema,
} from '../src/index.js';

export interface Started {
  mod: TestingModule;
  app: TestApp;
}

/** Boots an app with GraphQLModule.forRoot(options) plus `imports`, listening on a random port. */
export async function startGraphQL(
  imports: ModuleImport[],
  options: GraphQLModuleOptions = {},
  providers: Provider[] = [],
): Promise<Started> {
  const mod = await Test.createModule({
    imports: [GraphQLModule.forRoot(options), ...imports],
    providers,
  }).compile({ development: false });
  const app = await mod.createApp();
  return { mod, app };
}

/** Bootstraps without listening and returns the sorted SDL. */
export async function sdlOf(
  imports: ModuleImport[],
  options: GraphQLModuleOptions = {},
): Promise<string> {
  const mod = await Test.createModule({
    imports: [GraphQLModule.forRoot(options), ...imports],
  }).compile();
  try {
    return printSortedSchema(mod.get(GraphQLRuntime).schema);
  } finally {
    await mod.close();
  }
}

/** Polls until `check` is true (default 2s), for state that settles asynchronously. */
export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('until(): condition not met in time');
    await Bun.sleep(5);
  }
}
