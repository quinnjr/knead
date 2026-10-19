import { BadRequestException, MethodNotAllowedException } from '@knead-js/http';
import type { GraphQLResponse } from '@leaven-graphql/core';
import type { OperationKind } from './context.js';
import type { ResolvedGraphQLOptions } from './options.js';

// Response helpers shared by the JSON and SSE transports. A leaf module (no imports from this
// package but types), so runtime.ts, http.ts and sse.ts import it without an import cycle.

export const GRAPHQL_RESPONSE_JSON = 'application/graphql-response+json';

/** The q value Accept gives `type`: an exact range wins over a type wildcard, then any. */
export function acceptQuality(accept: string | null, type: string, exact = false): number {
  if (accept === null || accept.trim() === '') return type === 'application/json' ? 1 : 0;
  const major = `${type.split('/')[0]}/*`;
  let best = -1;
  let specificity = -1;
  for (const part of accept.split(',')) {
    const [range, ...params] = part.split(';').map((p) => p.trim().toLowerCase());
    const rank = range === type ? 2 : exact ? -1 : range === major ? 1 : range === '*/*' ? 0 : -1;
    if (rank < specificity || rank < 0) continue;
    const q = params.find((p) => p.startsWith('q='));
    const quality = q ? Number(q.slice(2)) : 1;
    if (rank > specificity || quality > best) best = Number.isFinite(quality) ? quality : 0;
    specificity = rank;
  }
  return Math.max(best, 0);
}

/**
 * The status of a GraphQL response with no `data` under the graphql-response+json mapping: 500
 * when any error is INTERNAL_SERVER_ERROR (a server failure), otherwise 400.
 */
export function noDataStatus(response: GraphQLResponse<unknown>): 400 | 500 {
  const internal = response.errors?.some((e) => e.extensions?.code === 'INTERNAL_SERVER_ERROR');
  return internal ? 500 : 400;
}

/** Headers of a JSON GraphQL response: `contentType`, nosniff and `options.cacheControl`. */
export function jsonHeaders(
  runtime: { readonly options: Pick<ResolvedGraphQLOptions, 'cacheControl'> },
  contentType: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': `${contentType}; charset=utf-8`,
    'x-content-type-options': 'nosniff',
  };
  const cacheControl = runtime.options.cacheControl;
  if (cacheControl !== false) headers['cache-control'] = cacheControl;
  return headers;
}

/**
 * Messages for an operation the transport does not carry. `sse` is whether GraphQL over SSE is on
 * (it carries subscriptions too).
 */
export function rejectionMessage(
  operation: OperationKind,
  allowed: readonly OperationKind[],
  sse: boolean,
): string {
  if (allowed.length === 1 && allowed[0] === 'subscription') {
    return 'Only subscription operations are allowed over WebSocket.';
  }
  if (operation === 'subscription') {
    return sse
      ? 'Subscriptions are only available over WebSocket or with Accept: text/event-stream.'
      : 'Subscriptions are only available over WebSocket.';
  }
  return `A ${operation} cannot be sent over GET; use POST.`;
}

/**
 * Throws the HTTP error for an operation the onExecute check refused on an HTTP request (JSON or
 * SSE): a subscription sent over POST is a 400; anything else (a mutation, or a subscription over
 * GET) is a 405 with `Allow: POST`.
 */
export function throwRejected(
  rejected: OperationKind | undefined,
  allowed: readonly OperationKind[],
  method: string,
  sse: boolean,
): void {
  if (!rejected) return;
  const message = rejectionMessage(rejected, allowed, sse);
  if (rejected === 'subscription' && method !== 'GET') throw new BadRequestException(message);
  throw new MethodNotAllowedException(message, { headers: { allow: 'POST' } });
}
