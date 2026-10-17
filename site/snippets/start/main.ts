import { KneadFactory } from '@knead-js/http';
import { AppModule } from './app.module.js';

const app = await KneadFactory.create(AppModule);
// Close cleanly on SIGTERM and SIGINT: stop accepting requests, finish in-flight ones, run
// shutdown hooks, then exit.
app.enableShutdownHooks();
await app.listen({ port: 3000, hostname: '127.0.0.1' });
