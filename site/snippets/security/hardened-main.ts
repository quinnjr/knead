import { KneadFactory } from '@knead-js/http';
import { AppModule } from './hardened-app.js';

// #region listen
const app = await KneadFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen({
  port: 3000,
  // The public names this server answers to; any other Host gets 421.
  allowedHosts: ['api.example.com'],
  // Proxies in 10.0.0.0/8 are trusted: ctx.ip and ctx.secure follow their X-Forwarded-* headers.
  trustProxy: ['10.0.0.0/8'],
  // Per-user API responses must not be stored by shared caches.
  defaultCacheControl: 'no-store',
  // Issue messages never echo the submitted values back.
  validation: { redactIssueMessages: true },
});
// #endregion listen
