import { type ConfigLoader, ConfigModule } from '@knead-js/config';
import { Module } from '@knead-js/core';
import { AppConfig } from './app-config.js';

/** Reads a JSON object of SCREAMING_SNAKE_CASE names, such as a mounted secrets file. */
export function jsonFile(path: string): ConfigLoader {
  return async function jsonFile() {
    const file = Bun.file(path);
    if (!(await file.exists())) return {};
    return (await file.json()) as Record<string, string>;
  };
}

@Module({
  imports: [
    ConfigModule.forRoot(AppConfig, {
      // Later loaders win: the secrets file overrides the shared defaults file.
      loaders: [jsonFile('/etc/shop/defaults.json'), jsonFile('/run/secrets/shop.json')],
    }),
  ],
})
export class AppModule {}
