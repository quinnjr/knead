import { HpmwsFactory } from '@hpmws/http';
import { AppModule } from './app.module.js';

const app = await HpmwsFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen({ port: Number(process.env.PORT ?? 3000) });
