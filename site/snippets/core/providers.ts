import { Injectable, InjectionToken, inject, Module, type Provider } from '@knead-js/core';

// #region tokens
export interface AppConfig {
  databaseUrl: string;
  port: number;
}

// The type parameter is what inject(APP_CONFIG) returns.
export const APP_CONFIG = new InjectionToken<AppConfig>('APP_CONFIG');
// #endregion tokens

// #region abstract
export abstract class Cache {
  abstract get(key: string): string | undefined;
  abstract set(key: string, value: string): void;
}

@Injectable()
export class MemoryCache extends Cache {
  readonly #entries = new Map<string, string>();

  get(key: string): string | undefined {
    return this.#entries.get(key);
  }

  set(key: string, value: string): void {
    this.#entries.set(key, value);
  }
}
// #endregion abstract

// #region forms
@Injectable()
export class Connection {
  readonly url = inject(APP_CONFIG).databaseUrl;
}

export const CONNECTION_LABEL = new InjectionToken<string>('CONNECTION_LABEL');
export const LEGACY_CACHE = new InjectionToken<Cache>('LEGACY_CACHE');

export const providers: Provider[] = [
  // Value: the object itself, as is.
  { provide: APP_CONFIG, useValue: { databaseUrl: 'postgres://db.internal/app', port: 3000 } },
  // Class: inject(Cache) gets a MemoryCache.
  { provide: Cache, useClass: MemoryCache },
  // Shorthand for { provide: Connection, useClass: Connection }.
  Connection,
  // Factory: runs in the injection context.
  { provide: CONNECTION_LABEL, useFactory: () => `db at ${inject(Connection).url}` },
  // Alias: the same instance as Cache, under another token.
  { provide: LEGACY_CACHE, useExisting: Cache },
];
// #endregion forms

// #region async
export interface Secrets {
  apiKey: string;
}

export const SECRETS = new InjectionToken<Secrets>('SECRETS');

async function fetchSecrets(url: string): Promise<Secrets> {
  await Bun.sleep(1);
  return { apiKey: `key-for-${url}` };
}

export const secretsProvider = {
  provide: SECRETS,
  useFactory: async () => {
    // inject() first: after the first await there is no injection context.
    const config = inject(APP_CONFIG);
    return fetchSecrets(config.databaseUrl);
  },
};

@Injectable()
export class PaymentsClient {
  // Classes can inject an async provider: it has settled before any class is built.
  readonly apiKey = inject(SECRETS).apiKey;
}
// #endregion async

// #region multi
export interface HealthCheck {
  name: string;
  check(): boolean;
}

export const HEALTH_CHECKS = new InjectionToken<HealthCheck[]>('HEALTH_CHECKS');

export const healthChecks: Provider[] = [
  { provide: HEALTH_CHECKS, multi: true, useValue: { name: 'memory', check: () => true } },
  {
    provide: HEALTH_CHECKS,
    multi: true,
    useFactory: () => {
      const cache = inject(Cache); // in the factory body, not inside check()
      return { name: 'cache', check: () => cache instanceof MemoryCache };
    },
  },
];

@Injectable()
export class HealthService {
  readonly checks = inject(HEALTH_CHECKS);

  report(): Record<string, boolean> {
    return Object.fromEntries(this.checks.map((c) => [c.name, c.check()]));
  }
}
// #endregion multi

// #region transient
@Injectable({ scope: 'transient' })
export class RequestIdGenerator {
  readonly id = crypto.randomUUID();
}

@Injectable()
export class AuditLog {
  readonly ids = inject(RequestIdGenerator);
}

@Injectable()
export class AccessLog {
  readonly ids = inject(RequestIdGenerator);
}
// #endregion transient

@Module({
  providers: [
    ...providers,
    secretsProvider,
    PaymentsClient,
    ...healthChecks,
    HealthService,
    RequestIdGenerator,
    AuditLog,
    AccessLog,
  ],
})
export class AppModule {}
