import { describe, expect, test } from 'bun:test';
import { ConsoleLogger, Injectable, inject, LOGGER, type Logger, Module } from '@knead-js/core';
import { KneadFactory, MemoryLogger } from '../src/index.js';

@Injectable()
class Service {
  readonly log = inject(LOGGER);
}

/** A feature module that does not import the module providing LOGGER. */
@Module({ providers: [Service], exports: [Service] })
class Feature {}

function globalLogger(logger: Logger) {
  @Module({ global: true, providers: [{ provide: LOGGER, useValue: logger }], exports: [LOGGER] })
  class LogModule {}
  return LogModule;
}

describe('the LOGGER of a KneadFactory application', () => {
  test('defaults to a ConsoleLogger, the same one everywhere', async () => {
    @Module({ imports: [Feature] })
    class App {}
    const app = await KneadFactory.create(App);
    expect(app.logger).toBeInstanceOf(ConsoleLogger);
    expect(app.get(Service).log).toBe(app.logger);
  });

  test("a global module's LOGGER is used everywhere, not only in modules importing it", async () => {
    const mine = new MemoryLogger();
    @Module({ imports: [globalLogger(mine), Feature] })
    class App {}
    const app = await KneadFactory.create(App);
    expect(app.logger).toBe(mine);
    expect(app.get(Service).log).toBe(mine);
  });

  test('the logger option wins over a global module, everywhere', async () => {
    const explicit = new MemoryLogger();
    @Module({ imports: [globalLogger(new MemoryLogger()), Feature] })
    class App {}
    const app = await KneadFactory.create(App, { logger: explicit });
    expect(app.logger).toBe(explicit);
    expect(app.get(Service).log).toBe(explicit);
  });

  test('an explicit LOGGER override wins over the logger option', async () => {
    const override = new MemoryLogger();
    @Module({ imports: [Feature] })
    class App {}
    const app = await KneadFactory.create(App, {
      logger: new MemoryLogger(),
      overrides: [[LOGGER, { provide: LOGGER, useValue: override }]],
    });
    expect(app.logger).toBe(override);
    expect(app.get(Service).log).toBe(override);
  });
});
