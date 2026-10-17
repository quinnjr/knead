import { Module } from '@knead-js/core';
import { KneadFactory, requestUrl, withHeaders } from '@knead-js/http';
import { CatsController, CatsService } from './controllers.js';

@Module({ controllers: [CatsController], providers: [CatsService] })
export class AppModule {}

// #region bootstrap
export async function main(): Promise<void> {
  const app = await KneadFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen({ hostname: '127.0.0.1', port: 3000 });
  for (const route of app.routes) {
    app.logger.info(`${route.method} ${route.path} -> ${route.handler}`);
  }
}
// #endregion bootstrap

// #region helpers
export function noStore(res: Response): Response {
  // Mutates res when its headers are mutable, otherwise returns a copy.
  return withHeaders(res, { 'cache-control': 'no-store' });
}

export function pathOf(req: Request): string {
  // Never throws, even for a request whose Host header is not a valid URL authority.
  return requestUrl(req).pathname;
}
// #endregion helpers
