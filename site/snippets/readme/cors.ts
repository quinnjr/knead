// #region quick-start
import { Module } from '@knead-js/core';
import { CorsModule } from '@knead-js/cors';
import { Controller, Get } from '@knead-js/http';

@Controller('/api')
export class ProjectsController {
  @Get('/projects')
  list() {
    return [{ id: 1, name: 'Apollo' }];
  }
}

@Module({
  imports: [
    CorsModule.forRoot({
      origin: ['https://app.example.com', 'https://admin.example.com'],
      credentials: true,
      maxAge: 600,
    }),
  ],
  controllers: [ProjectsController],
})
export class AppModule {}
// #endregion quick-start
