import { Module } from '@knead-js/core';
import { GraphQLModule, RedisPubSub } from '@knead-js/graphql';
import { BlogModule } from './blog.module.js';

// #region redis
/** Shared by every instance, so an event published on one reaches subscribers on all. */
export function createPubSub(env: Record<string, string | undefined>): RedisPubSub {
  return new RedisPubSub({
    url: env.REDIS_URL,
    // Throw at startup for a plaintext redis:// URL to another host.
    requireTls: env.NODE_ENV === 'production',
    // `openssl rand -base64 32`, the same on every instance.
    signingKey: env.REDIS_PUBSUB_SIGNING_KEY,
    encryptionKey: env.REDIS_PUBSUB_ENCRYPTION_KEY,
  });
}

@Module({
  imports: [
    GraphQLModule.forRootAsync({
      useFactory: () => ({ pubsub: createPubSub(process.env) }),
    }),
    BlogModule,
  ],
})
export class ScaledAppModule {}
// #endregion redis
