import { KneadFactory } from '@knead-js/http';
import { JsonLogger } from '@knead-js/logging';
import { AppModule } from './app.module.js';

export function createApp() {
  // The logger option is the LOGGER of every module, whatever the modules provide.
  return KneadFactory.create(AppModule, { logger: new JsonLogger({ name: 'orders-api' }) });
}
