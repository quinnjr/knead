import { afterEach, expect, test } from 'bun:test';
import { Config, ConfigModule } from '@knead-js/config';
import { Test, type TestingModule } from '@knead-js/testing';
import { AppConfig } from './app-config.js';
import { SignupService } from './signup.service.js';

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

// #region override
test('signups follow the signupsOpen flag', async () => {
  mod = await Test.createModule({
    imports: [ConfigModule.forRoot(AppConfig)],
    providers: [SignupService],
  })
    .overrideProvider(AppConfig)
    .useValue(
      new Config({
        port: 3000,
        databaseUrl: 'postgres://localhost/shop_test',
        jwtSecret: 'test-secret-that-is-at-least-32-chars',
        signupsOpen: true,
      }),
    )
    .compile();

  expect(mod.get(SignupService).isOpen()).toBe(true);
});
// #endregion override

// #region values
test('values run through the schema like environment strings', async () => {
  mod = await Test.createModule({
    imports: [
      ConfigModule.forRoot(AppConfig, {
        values: {
          databaseUrl: 'postgres://localhost/shop_test',
          jwtSecret: 'test-secret-that-is-at-least-32-chars',
          port: '4100',
        },
      }),
    ],
    providers: [SignupService],
  }).compile();

  expect(mod.get(SignupService).port()).toBe(4100);
});
// #endregion values
