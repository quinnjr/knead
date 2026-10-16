import type { Logger } from './logger.js';

/**
 * The oldest Bun Knead supports: 1.4.3 fixes CVE-2026-48618 (TLS hostname matching, including
 * Bun.RedisClient), request smuggling through bare-LF chunked bodies, WebSocket frames sent with
 * the upgrade request, `req.url`/headers of aborted requests and the TLS handshake idle timeout.
 */
export const MIN_BUN_VERSION = '1.4.3';

/**
 * Compares two `major.minor.patch` versions (a pre-release or build suffix is ignored):
 * negative when `a` is older than `b`, 0 when equal, positive when newer. No dependencies.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

let warned = false;

/** Logs once per process when `version` (default: the running Bun) is older than 1.4.3. */
export function checkBunVersion(logger: Logger, version: string = Bun.version): boolean {
  if (compareVersions(version, MIN_BUN_VERSION) >= 0) return true;
  if (!warned) {
    warned = true;
    logger.warn(
      `Bun ${version} is older than ${MIN_BUN_VERSION}, which fixes CVE-2026-48618 (TLS hostname ` +
        'matching, including Bun.RedisClient), request smuggling through bare-LF chunked bodies ' +
        'and other server bugs. Upgrade Bun.',
    );
  }
  return false;
}

/** @internal For tests: lets checkBunVersion() warn again. */
export function resetBunVersionWarning(): void {
  warned = false;
}
