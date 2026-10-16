import { KneadError } from '@knead-js/core';

export class ConfigError extends KneadError {}

export class ConfigDefinitionError extends ConfigError {}

export class ConfigKeyCollisionError extends ConfigError {
  constructor(
    readonly key: string,
    readonly sources: [string, string],
    sourceName: string,
  ) {
    super(`${sourceName}: ${sources[0]} and ${sources[1]} both map to config key "${key}".`);
  }
}

export class ConfigLoaderError extends ConfigError {
  constructor(
    readonly index: number,
    loaderName: string,
    options: { cause: unknown },
  ) {
    super(`Config loader #${index} (${loaderName || 'anonymous'}) failed.`);
    this.cause = options.cause;
  }
}

export interface ConfigIssue {
  key: string;
  name: string;
  path: string[];
  message: string;
}

export class ConfigValidationError extends ConfigError {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(
      `Config validation failed:\n${issues.map((i) => `  ${i.name} (${i.key}): ${i.message}`).join('\n')}`,
    );
  }
}
