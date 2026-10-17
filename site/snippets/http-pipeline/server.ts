import { Module } from '@knead-js/core';
import {
  Controller,
  Get,
  type HttpApplication,
  KneadFactory,
  type ListenOptions,
} from '@knead-js/http';

@Controller()
export class HealthController {
  @Get('/health')
  health() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController] })
export class AppModule {}

// #region production
export const productionListen: ListenOptions = {
  port: 8080,
  allowedHosts: ['api.example.com'],
  trustProxy: ['10.0.0.0/8'],
  defaultCacheControl: 'no-store',
  maxRequestBodySize: 256 * 1024,
  shutdownTimeout: 15_000,
};

export async function bootstrap(
  listen: ListenOptions = productionListen,
): Promise<HttpApplication> {
  const app = await KneadFactory.create(AppModule);
  try {
    await app.listen(listen);
  } catch (error) {
    await app.close();
    throw error;
  }
  return app.enableShutdownHooks();
}
// #endregion production

// #region tls
export async function bootstrapTls(): Promise<HttpApplication> {
  const app = await KneadFactory.create(AppModule);
  await app.listen({
    port: 443,
    tls: {
      cert: Bun.file('/etc/knead/tls/api.crt'),
      key: Bun.file('/etc/knead/tls/api.key'),
    },
    redirectHttp: { port: 80, host: 'api.example.com' },
    allowedHosts: ['api.example.com'],
  });
  return app.enableShutdownHooks();
}
// #endregion tls
