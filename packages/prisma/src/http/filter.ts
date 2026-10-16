import { DEVELOPMENT, inject, LOGGER } from '@knead-js/core';
import { defaultErrorResponse, type ExceptionFilter } from '@knead-js/http';
import { toHttpException } from './to-http-exception.js';
import { PRISMA_HTTP_OPTIONS } from './tokens.js';

/** Answers Prisma errors with problem responses; declines everything else. */
export class PrismaExceptionFilter implements ExceptionFilter {
  readonly #logger = inject(LOGGER);
  readonly #development = inject(DEVELOPMENT);
  readonly #options = inject(PRISMA_HTTP_OPTIONS);

  catch(error: unknown, ctx: Parameters<ExceptionFilter['catch']>[1]): Response | undefined {
    const exception = toHttpException(error, {
      map: this.#options.map,
      development: this.#development,
    });
    return exception && defaultErrorResponse(exception, ctx, this.#logger, this.#development);
  }
}
