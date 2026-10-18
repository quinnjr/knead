import { Injectable, inject, Module } from '@knead-js/core';
import {
  APP_FILTER,
  Catch,
  Controller,
  type Ctx,
  type ExceptionFilter,
  Get,
  HttpException,
  NotFoundException,
  problemResponse,
  requestUrl,
  UseFilters,
} from '@knead-js/http';

// #region catch
export class AccountNotFoundError extends Error {
  constructor(readonly accountId: string) {
    super(`Account ${accountId} does not exist`);
  }
}

@Catch(AccountNotFoundError)
export class AccountNotFoundFilter implements ExceptionFilter<AccountNotFoundError> {
  catch(error: AccountNotFoundError, ctx: Ctx): Response {
    const problem = new NotFoundException(error.message).toProblem(requestUrl(ctx.req).pathname);
    return problemResponse(problem);
  }
}
// #endregion catch

// #region scopes
const statementUnavailable: ExceptionFilter = {
  catch: () => new Response(null, { status: 503, headers: { 'retry-after': '30' } }),
};

@Controller('/accounts')
@UseFilters(AccountNotFoundFilter)
export class AccountsController {
  @Get('/:id')
  find(ctx: Ctx<{ params: { id: string } }>) {
    if (ctx.params.id !== 'acc_1') throw new AccountNotFoundError(ctx.params.id);
    return { id: 'acc_1', balance: 120 };
  }

  @Get('/:id/statement', { filters: [statementUnavailable] })
  statement(ctx: Ctx<{ params: { id: string } }>): never {
    throw new AccountNotFoundError(ctx.params.id);
  }
}
// #endregion scopes

// #region decline
@Injectable()
export class ErrorTracker {
  readonly reported: unknown[] = [];

  capture(error: unknown): void {
    this.reported.push(error);
  }
}

export class ReportUnexpected implements ExceptionFilter {
  readonly #tracker = inject(ErrorTracker);

  catch(error: unknown): undefined {
    if (!(error instanceof HttpException) || error.status >= 500) this.#tracker.capture(error);
    return undefined;
  }
}

@Module({
  controllers: [AccountsController],
  providers: [ErrorTracker, { provide: APP_FILTER, multi: true, useValue: ReportUnexpected }],
})
export class AppModule {}
// #endregion decline
