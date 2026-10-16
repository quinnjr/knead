import { Controller, Get } from '@hpmws/http';
import { SkipRateLimit } from '@hpmws/rate-limit';

/**
 * A plain REST route next to the GraphQL endpoint. Not rate limited, for health checks. It
 * returns only the status: counts, versions or infrastructure details would tell anonymous
 * callers more than they need.
 */
@Controller('/health')
export class HealthController {
  @Get('/')
  @SkipRateLimit()
  health() {
    return { status: 'ok' };
  }
}
