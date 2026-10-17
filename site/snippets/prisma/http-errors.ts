import { Module } from '@knead-js/core';
import { ServiceUnavailableException } from '@knead-js/http';
import { PrismaHttpModule } from '@knead-js/prisma/http';

// #region map
@Module({
  imports: [
    PrismaHttpModule.forRoot({
      map: {
        // P2034: a write conflict or deadlock; ask the client to retry.
        P2034: () =>
          new ServiceUnavailableException('Retry the request.', {
            headers: { 'retry-after': '1' },
          }),
      },
    }),
  ],
})
export class PrismaErrorsModule {}
// #endregion map
