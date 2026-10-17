import { inject } from '@knead-js/core';
import { AppConfig } from './app-config.js';

export class SignupService {
  readonly #config = inject(AppConfig);

  isOpen(): boolean {
    return this.#config.get('signupsOpen'); // boolean, parsed from 'true' or 'false'
  }

  port(): number {
    return this.#config.get('port'); // number, 3000 when PORT is unset
  }
}
