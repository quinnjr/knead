import type { LogLevel } from '@knead-js/core';
import { LoggingModule } from '@knead-js/logging';

/** Buffers records and ships them in batches. */
export class LogShipper {
  readonly pending: { line: string; level: LogLevel }[] = [];

  // `line` is one record of JSON without the trailing newline.
  write = (line: string, level: LogLevel): void => {
    this.pending.push({ line, level });
  };

  async flush(): Promise<void> {
    const body = this.pending.splice(0).map((record) => `${record.line}\n`);
    if (body.length > 0) {
      await fetch('https://logs.example.com/ingest', { method: 'POST', body: body.join('') });
    }
  }
}

export const shipper = new LogShipper();

export const Logging = LoggingModule.forRoot({ write: shipper.write });
