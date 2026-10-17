import { loadConfig } from '@knead-js/config';
import { AppConfig } from './app-config.js';

/** Reads AppConfig outside a module, for example in a migration script. */
export async function migrationTarget(env: Record<string, string | undefined> = process.env) {
  const config = await loadConfig(AppConfig, {}, env);
  return config.get('databaseUrl');
}
