import { ConfigModule } from '@knead-js/config';
import { InjectionToken, inject, Module } from '@knead-js/core';
import { AppConfig } from './app-config.js';

export interface SecretStore {
  /** Returns the secrets under `path`, keyed by SCREAMING_SNAKE_CASE name. */
  read(path: string): Promise<Record<string, string>>;
}

export const SECRET_STORE = new InjectionToken<SecretStore>('SECRET_STORE');

/** A store that reads a Vault KV v2 secret over HTTP. */
class VaultSecretStore implements SecretStore {
  constructor(
    private readonly address: string,
    private readonly token: string,
  ) {}

  async read(path: string): Promise<Record<string, string>> {
    const res = await fetch(new URL(`/v1/secret/data/${path}`, this.address), {
      headers: { 'x-vault-token': this.token },
    });
    // Name the path and status only: never put secret values in an error message.
    if (!res.ok) throw new Error(`Vault read of ${path} failed with ${res.status}`);
    const body = (await res.json()) as { data: { data: Record<string, string> } };
    return body.data.data;
  }
}

@Module({
  providers: [
    {
      provide: SECRET_STORE,
      useFactory: () =>
        new VaultSecretStore(process.env.VAULT_ADDR ?? '', process.env.VAULT_TOKEN ?? ''),
    },
  ],
  exports: [SECRET_STORE],
})
export class SecretsModule {}

// #region forRootAsync
export const ShopConfigModule = ConfigModule.forRootAsync(AppConfig, {
  imports: [SecretsModule],
  useFactory: () => {
    // useFactory runs in the injection context: inject() here, not inside a loader.
    const store = inject(SECRET_STORE);
    return { loaders: [() => store.read('shop/production')] };
  },
});

@Module({ imports: [ShopConfigModule] })
export class AppModule {}
// #endregion forRootAsync
