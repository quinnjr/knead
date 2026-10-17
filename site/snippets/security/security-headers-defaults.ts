import { Module } from '@knead-js/core';
import { Controller, Get } from '@knead-js/http';
import { SecurityHeadersModule } from '@knead-js/security-headers';

@Controller('/')
export class StatusController {
  @Get('/status')
  status() {
    return { ok: true };
  }
}

// #region module
@Module({
  imports: [SecurityHeadersModule.forRoot()],
  controllers: [StatusController],
})
export class AppModule {}
// #endregion module
