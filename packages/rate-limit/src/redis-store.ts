import { RedisClient } from 'bun';
import type { Algorithm, ConsumeResult, RateLimitRule, RateLimitStore } from './store.js';

// Both scripts mirror MemoryStore. KEYS[1] = key, ARGV[1] = limit, ARGV[2] = windowMs.
// They return {allowed, remaining, resetAt}; Redis TIME is the clock.

const SLIDING_WINDOW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit = tonumber(ARGV[1])
local w = tonumber(ARGV[2])
local ws = math.floor(now / w) * w
local windowEnd = ws + w
local currKey = KEYS[1] .. ':' .. string.format('%.0f', ws)
local prevKey = KEYS[1] .. ':' .. string.format('%.0f', ws - w)
local curr = tonumber(redis.call('GET', currKey) or '0')
local prev = tonumber(redis.call('GET', prevKey) or '0')
local weight = math.min(1, math.max(0, (w - (now - ws)) / w))
if prev * weight + curr + 1 > limit then
  local retry
  if prev > 0 and curr + 1 <= limit then
    local solve = math.ceil(ws + w - ((limit - curr - 1) * w) / prev)
    if solve < windowEnd then retry = math.max(now, solve) end
  end
  if retry == nil then
    if curr <= limit - 1 then
      retry = windowEnd
    else
      retry = math.max(windowEnd, math.ceil(windowEnd + w - ((limit - 1) * w) / curr))
    end
  end
  return {0, 0, retry}
end
curr = redis.call('INCR', currKey)
if curr == 1 then redis.call('PEXPIRE', currKey, math.ceil(w * 2)) end
local remaining = math.max(0, math.floor(limit - (prev * weight + curr)))
return {1, remaining, windowEnd}
`;

const TOKEN_BUCKET = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit = tonumber(ARGV[1])
local w = tonumber(ARGV[2])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = limit
  ts = now
else
  tokens = math.min(limit, tokens + math.max(0, now - ts) * limit / w)
  ts = math.max(now, ts)
end
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', string.format('%.17g', tokens), 'ts', string.format('%.0f', ts))
redis.call('PEXPIRE', KEYS[1], math.max(1, math.ceil(w + (ts - now))))
local missing
if allowed == 1 then missing = limit - tokens else missing = 1 - tokens end
return {allowed, math.floor(tokens), ts + math.ceil(missing * w / limit)}
`;

const SCRIPTS: Record<Algorithm, string> = {
  'sliding-window': SLIDING_WINDOW,
  'token-bucket': TOKEN_BUCKET,
};
const sha1 = (s: string) => new Bun.CryptoHasher('sha1').update(s).digest('hex');
const SHAS: Record<Algorithm, string> = {
  'sliding-window': sha1(SLIDING_WINDOW),
  'token-bucket': sha1(TOKEN_BUCKET),
};

export interface RedisStoreOptions {
  /** An existing client (not closed by close()). */
  client?: RedisClient;
  /** Connection URL when no client is given (default: Bun's REDIS_URL / localhost). */
  url?: string;
  /** Key prefix. Default 'hpmws:rl:'. */
  prefix?: string;
}

/**
 * Atomic rate limiting shared across instances, with the same semantics as MemoryStore. Each
 * consume() is one Lua script (EVALSHA, falling back to EVAL on NOSCRIPT) that uses the Redis
 * TIME as its clock.
 *
 * Known limitation: sliding-window keys are derived inside the script, so this store does not
 * support Redis Cluster. Keys include the window, so changing a rule's window starts fresh state.
 */
export class RedisStore implements RateLimitStore {
  readonly #client: RedisClient;
  readonly #owned: boolean;
  readonly #prefix: string;

  constructor(options: RedisStoreOptions = {}) {
    this.#owned = options.client === undefined;
    this.#client = options.client ?? new RedisClient(options.url);
    this.#prefix = options.prefix ?? 'hpmws:rl:';
  }

  async consume(key: string, rule: RateLimitRule): Promise<ConsumeResult> {
    if (!Number.isInteger(rule.limit) || rule.limit < 1) {
      throw new RangeError(`Rate limit must be a positive integer, got ${String(rule.limit)}.`);
    }
    if (!Number.isInteger(rule.windowMs) || rule.windowMs <= 0) {
      throw new RangeError(
        `Rate limit window must be a positive integer (ms), got ${String(rule.windowMs)}.`,
      );
    }
    const algorithm: Algorithm =
      rule.algorithm === 'token-bucket' ? 'token-bucket' : 'sliding-window';
    const args = [
      '1',
      `${this.#prefix}${key}:${rule.windowMs}`,
      String(rule.limit),
      String(rule.windowMs),
    ];
    let reply: unknown;
    try {
      reply = await this.#client.send('EVALSHA', [SHAS[algorithm], ...args]);
    } catch (error) {
      if (!String((error as Error | undefined)?.message).includes('NOSCRIPT')) throw error;
      reply = await this.#client.send('EVAL', [SCRIPTS[algorithm], ...args]);
    }
    const [allowed, remaining, resetAt] = reply as [number, number, number];
    return {
      allowed: Number(allowed) === 1,
      remaining: Number(remaining),
      resetAt: Number(resetAt),
    };
  }

  async close(): Promise<void> {
    if (this.#owned) this.#client.close();
  }
}
