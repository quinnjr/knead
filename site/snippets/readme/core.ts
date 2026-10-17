// #region quick-start
import { ApplicationContext, InjectionToken, inject, Module } from '@knead-js/core';

interface MailConfig {
  from: string;
}

const MAIL_CONFIG = new InjectionToken<MailConfig>('MAIL_CONFIG');

export class Mailer {
  readonly #config = inject(MAIL_CONFIG);

  send(to: string, subject: string): string {
    return `${this.#config.from} -> ${to}: ${subject}`;
  }
}

@Module({
  providers: [{ provide: MAIL_CONFIG, useValue: { from: 'noreply@example.com' } }, Mailer],
  exports: [Mailer],
})
export class MailModule {}

export class SignupService {
  readonly #mailer = inject(Mailer);

  register(email: string): string {
    return this.#mailer.send(email, 'Welcome');
  }
}

@Module({ imports: [MailModule], providers: [SignupService] })
export class AppModule {}

const app = await ApplicationContext.create(AppModule);
console.log(app.get(SignupService).register('ada@example.com'));
// noreply@example.com -> ada@example.com: Welcome
await app.close();
// #endregion quick-start
