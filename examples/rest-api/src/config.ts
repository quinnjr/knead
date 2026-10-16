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
