import { Injectable, inject, Module } from '@knead-js/core';
import { Database, DatabaseModule } from './feature-modules.js';

// #region reexport
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}

// Importers of SharedModule see Clock and everything DatabaseModule exports.
@Module({
  imports: [DatabaseModule],
  providers: [Clock],
  exports: [Clock, DatabaseModule],
})
export class SharedModule {}

@Injectable()
export class ReportsService {
  readonly db = inject(Database);
  readonly clock = inject(Clock);
}

@Module({ imports: [SharedModule], providers: [ReportsService] })
export class ReportsModule {}
// #endregion reexport
