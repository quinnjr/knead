/** PubSub topics. Payloads must survive JSON (RedisPubSub serializes them). */
export const POST_PUBLISHED = 'post.published';
export const commentTopic = (postId: string) => `post.${postId}.comments`;
