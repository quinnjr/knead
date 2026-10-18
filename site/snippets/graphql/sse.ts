import { Module } from '@knead-js/core';
import { GraphQLModule } from '@knead-js/graphql';
import { BlogModule } from './blog.module.js';

// #region opt-out
@Module({
  imports: [
    GraphQLModule.forRoot({
      // Subscriptions over WebSocket only: Accept: text/event-stream gets the usual JSON.
      subscriptions: { sse: false },
    }),
    BlogModule,
  ],
})
export class WebSocketOnlyModule {}
// #endregion opt-out

// #region client
interface ExecutionResult {
  data?: unknown;
  errors?: readonly { message: string; extensions?: Record<string, unknown> }[];
}

/**
 * Runs one operation over graphql-sse (distinct connections mode) and yields each result: one
 * for a query or mutation, one per event for a subscription. Breaking out of the loop (or
 * `return()`) ends the request, and the server ends the subscription.
 */
export async function* subscribe(
  url: string,
  query: string,
  { variables, token }: { variables?: Record<string, unknown>; token?: string } = {},
): AsyncGenerator<ExecutionResult, void, undefined> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      // onConnect gets {} over SSE: send credentials as a header (or a cookie).
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  // A request error, a refusal (403) or a connection limit (429, 503) is JSON, not a stream.
  if (res.status !== 200) throw new Error(`GraphQL SSE request failed: ${res.status}`);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      // Ended without `complete`: revoked, expired or the server shut down. Reconnect.
      if (done) throw new Error('GraphQL SSE stream ended without complete');
      buffer += value;
      for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        // Blocks without an event field are keep-alive comments (`:`).
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = [...block.matchAll(/^data: ?(.*)$/gm)].map((m) => m[1]).join('\n');
        if (event === 'complete') return;
        if (event === 'next') yield JSON.parse(data) as ExecutionResult;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
// #endregion client
