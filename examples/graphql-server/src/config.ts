/** Settings read from the environment once, at startup. */
export const config = {
  /** Browser origins allowed by CORS and for subscription sockets (comma-separated). */
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  /** Requests per client IP per minute. */
  rateLimit: Number(process.env.RATE_LIMIT ?? 100),
  /** When set, subscriptions use RedisPubSub so several instances share events. */
  redisUrl: process.env.REDIS_URL || undefined,
};
