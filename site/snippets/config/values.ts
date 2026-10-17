import { ConfigModule } from '@knead-js/config';
import { Module } from '@knead-js/core';
import { AppConfig } from './app-config.js';

@Module({
  imports: [
    // Code values are schema input, like environment strings, and win over every other source.
    ConfigModule.forRoot(AppConfig, { values: { port: '8080', signupsOpen: 'true' } }),
  ],
})
export class AppModule {}
