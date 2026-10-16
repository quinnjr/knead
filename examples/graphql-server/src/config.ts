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

/** RedisPubSub options from the environment: the signing key when one is set. */
export function redisPubSubOptions(env: Record<string, string | undefined>): {
  url: string | undefined;
  signingKey?: string;
} {
  const signingKey = env.REDIS_PUBSUB_SIGNING_KEY || undefined;
  return { url: env.REDIS_URL || undefined, ...(signingKey ? { signingKey } : {}) };
}

/**
 * Where the server listens: `HOST` (default 127.0.0.1, so a development server is not reachable
 * from the network) and `PORT` (default 3000). Set HOST=0.0.0.0 in a container.
 */
export function listenOptions(env: Record<string, string | undefined>): {
  hostname: string;
  port: number;
} {
  return { hostname: env.HOST || '127.0.0.1', port: Number(env.PORT ?? 3000) };
}
