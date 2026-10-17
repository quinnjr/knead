import { KneadFactory } from '@knead-js/http';
import { AppModule } from './app.module.js';

const app = await KneadFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen({ port: 3000 });
