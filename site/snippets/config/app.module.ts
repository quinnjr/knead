import { ConfigModule } from '@knead-js/config';
import { Module } from '@knead-js/core';
import { AppConfig } from './app-config.js';
import { SignupService } from './signup.service.js';

@Module({
  imports: [ConfigModule.forRoot(AppConfig)],
  providers: [SignupService],
})
export class AppModule {}
