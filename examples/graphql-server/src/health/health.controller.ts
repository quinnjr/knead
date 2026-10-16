import { inject } from '@hpmws/core';
import { PUBSUB, RedisPubSub } from '@hpmws/graphql';
import { Controller, Get } from '@hpmws/http';
import { SkipRateLimit } from '@hpmws/rate-limit';
import { BlogService } from '../blog/blog.service.js';

/** A plain REST route next to the GraphQL endpoint. Not rate limited, for health checks. */
@Controller('/health')
export class HealthController {
  readonly #blog = inject(BlogService);
  readonly #pubsub = inject(PUBSUB);

  @Get('/')
  @SkipRateLimit()
  health() {
    return {
      status: 'ok',
      posts: this.#blog.posts({ first: Number.MAX_SAFE_INTEGER, offset: 0 }).length,
      pubsub: this.#pubsub instanceof RedisPubSub ? 'redis' : 'memory',
    };
  }
}
