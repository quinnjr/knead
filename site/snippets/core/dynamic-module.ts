import {
  type DynamicModule,
  Injectable,
  InjectionToken,
  inject,
  Module,
  type ModuleImport,
} from '@knead-js/core';

// #region options
export interface MailOptions {
  from: string;
  transport: 'smtp' | 'log';
}

export interface MailModuleAsyncOptions {
  /** Modules whose exports the factory may inject. */
  imports?: ModuleImport[];
  /** Runs in the injection context: call inject() before the first await. */
  useFactory: () => MailOptions | Promise<MailOptions>;
}

export const MAIL_OPTIONS = new InjectionToken<MailOptions>('MAIL_OPTIONS');
// #endregion options

// #region service
@Injectable()
export class MailService {
  readonly options = inject(MAIL_OPTIONS);

  send(to: string, subject: string): string {
    return `${this.options.transport}: ${this.options.from} -> ${to}: ${subject}`;
  }
}
// #endregion service

// #region module
function validate(options: MailOptions): MailOptions {
  if (!options.from.includes('@')) {
    throw new Error(`MailModule: "from" must be an email address, got "${options.from}".`);
  }
  return options;
}

@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {
  static forRoot(options: MailOptions): DynamicModule {
    validate(options);
    return {
      module: MailModule,
      providers: [{ provide: MAIL_OPTIONS, useValue: options }],
    };
  }

  static forRootAsync(options: MailModuleAsyncOptions): DynamicModule {
    return {
      module: MailModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: MAIL_OPTIONS,
          useFactory: async () => validate(await options.useFactory()),
        },
      ],
    };
  }
}
// #endregion module

// #region usage
@Injectable()
export class Settings {
  readonly mailFrom = 'noreply@example.com';
}

@Module({ providers: [Settings], exports: [Settings] })
export class SettingsModule {}

@Module({
  imports: [
    MailModule.forRootAsync({
      imports: [SettingsModule],
      useFactory: () => ({ from: inject(Settings).mailFrom, transport: 'log' }),
    }),
  ],
})
export class AppModule {}
// #endregion usage
