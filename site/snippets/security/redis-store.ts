import { RateLimitModule, RedisStore } from '@knead-js/rate-limit';

// #region store
export function rateLimitModule(env: Record<string, string | undefined>) {
  return RateLimitModule.forRoot({
    limit: 100,
    window: '1m',
    algorithm: 'token-bucket',
    store: new RedisStore({
      url: env.RATE_LIMIT_REDIS_URL, // rediss://ratelimit:password@redis.internal:6380
      hashSecret: env.RATE_LIMIT_HASH_SECRET, // openssl rand -base64 32, same on every instance
      requireTls: true,
    }),
    // A Redis outage rejects requests with 503 instead of letting them through.
    onStoreError: 'deny',
  });
}
// #endregion store
