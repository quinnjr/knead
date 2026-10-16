import { KneadFactory } from '@knead-js/http';
import { AppModule } from './app.module.js';
import { listenOptions } from './config.js';

const app = await KneadFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen({
  ...listenOptions(process.env),
  // Behind a reverse proxy, trust its X-Forwarded-For/-Proto so rate limits key on the client
  // and ctx.secure reflects HTTPS. Trust only the proxy hops you run, never all of them:
  // trustProxy: 1, // one proxy hop; or the proxy's CIDRs, e.g. ['10.0.0.0/8']
});
