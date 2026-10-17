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
    // Non-enumerable, like a native `cause`, so serializers that walk own keys skip it.
    Object.defineProperty(this, 'cause', {
      value: options.cause,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
}

export interface ConfigIssue {
  key: string;
  name: string;
  /** Always `[key]` (or `[]` for a root issue); nested segments may derive from values and are dropped. */
  path: string[];
  message: string;
}

function describe(issue: ConfigIssue): string {
  return `  ${issue.name} (${issue.key}): ${issue.message}`;
}

export class ConfigValidationError extends ConfigError {
  constructor(
    readonly issues: readonly ConfigIssue[],
    summary = 'Config validation failed:',
  ) {
    super(issues.length > 0 ? `${summary}\n${issues.map(describe).join('\n')}` : summary);
  }
}
