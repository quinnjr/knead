import { ForbiddenError } from '@casl/ability';
import {
  Catch,
  type Ctx,
  type ExceptionFilter,
  ForbiddenException,
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
