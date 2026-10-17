import { ForbiddenError } from '@casl/ability';
import {
  Catch,
  type Ctx,
  type ExceptionFilter,
  ForbiddenException,
  type HttpException,
  problemResponse,
  requestUrl,
} from '@knead-js/http';

/** Turns a CASL ForbiddenError thrown by app code into a 403 problem (its message is not sent). */
@Catch(ForbiddenError)
export class CaslForbiddenFilter implements ExceptionFilter<ForbiddenError<any>> {
  catch(_error: ForbiddenError<any>, ctx: Ctx): Response {
    return problemResponse(new ForbiddenException().toProblem(requestUrl(ctx.req).pathname));
  }
}

/**
 * For `GraphQLModule.forRoot({ mapError: mapCaslError })`: a CASL ForbiddenError thrown by a
 * resolver becomes a plain FORBIDDEN error (its message is not sent); anything else is left as is.
 */
export function mapCaslError(error: unknown): HttpException | undefined {
  return error instanceof ForbiddenError ? new ForbiddenException() : undefined;
}
