// The @knead-js/core README's quick start, run as written.
import { expect, test } from 'bun:test';
import { ApplicationContext } from '@knead-js/core';
import { AppModule, SignupService } from '../snippets/readme/core.js';

test('the quick start sends the welcome message through the exported Mailer', async () => {
  const app = await ApplicationContext.create(AppModule);
  try {
    expect(app.get(SignupService).register('ada@example.com')).toBe(
      'noreply@example.com -> ada@example.com: Welcome',
    );
  } finally {
    await app.close();
  }
});
