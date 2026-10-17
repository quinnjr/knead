import { ApplicationContext, DEVELOPMENT, LOGGER, logError } from '@knead-js/core';
import { ReportModule } from './standalone.js';

// #region main
const context = await ApplicationContext.create(ReportModule);
const logger = context.get(LOGGER);
const development = context.get(DEVELOPMENT);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    context.close(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logError({ logger, development }, `Shutdown on ${signal} failed`, error);
        process.exit(1);
      },
    );
  });
}
// #endregion main
