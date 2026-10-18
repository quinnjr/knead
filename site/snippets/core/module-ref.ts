import { Injectable, InjectionToken, inject, MODULES, Module } from '@knead-js/core';

// #region modules
@Injectable()
export class ModuleReport {
  readonly #modules = inject(MODULES);

  describe(): string[] {
    return this.#modules.map(
      (ref) => `${ref.name}${ref.global ? ' (global)' : ''}: ${ref.controllers.length} controllers`,
    );
  }
}
// #endregion modules

export const GREETING = new InjectionToken<string>('GREETING');

@Module({
  global: true,
  providers: [{ provide: GREETING, useValue: 'hello' }],
  exports: [GREETING],
})
export class GreetingModule {}

@Module({ imports: [GreetingModule], providers: [ModuleReport] })
export class AppModule {}
