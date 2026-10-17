import { inject } from '@knead-js/core';
import {
  Catch,
  type Ctx,
  defaultErrorResponse,
  type ExceptionFilter,
  HTTP_DEVELOPMENT,
  LOGGER,
  withHeaders,
} from '@knead-js/http';

// #region filter
@Catch(Error)
export class NoStoreErrorsFilter implements ExceptionFilter<Error> {
  readonly #logger = inject(LOGGER);
  readonly #development = inject(HTTP_DEVELOPMENT);

  catch(error: Error, ctx: Ctx): Response {
    // The framework's own problem response (and logging), with one header added.
    const res = defaultErrorResponse(error, ctx, this.#logger, this.#development);
    return withHeaders(res, { 'cache-control': 'no-store' });
  }
}
// #endregion filter
