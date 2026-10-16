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

/**
 * RedisPubSub options from the environment: REDIS_PUBSUB_SIGNING_KEY (required under
 * NODE_ENV=production) signs events and
 * REDIS_PUBSUB_ENCRYPTION_KEY encrypts their payloads (each `openssl rand -base64 32`, from a
 * secret store or the environment).
 */
export function redisPubSubOptions(env: Record<string, string | undefined>): {
  url: string | undefined;
  signingKey?: string;
  encryptionKey?: string;
} {
  const signingKey = env.REDIS_PUBSUB_SIGNING_KEY || undefined;
  if (!signingKey && env.NODE_ENV === 'production') {
    // Unsigned events could be injected by anything that can publish to the Redis server.
    throw new Error(
      'REDIS_PUBSUB_SIGNING_KEY is required with REDIS_URL under NODE_ENV=production ' +
        '(generate one with `openssl rand -base64 32`).',
    );
  }
  const encryptionKey = env.REDIS_PUBSUB_ENCRYPTION_KEY || undefined;
  return {
    url: env.REDIS_URL || undefined,
    ...(signingKey ? { signingKey } : {}),
    ...(encryptionKey ? { encryptionKey } : {}),
  };
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
