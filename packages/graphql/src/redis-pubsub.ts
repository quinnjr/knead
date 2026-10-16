import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  ConsoleLogger,
  defaultRedisUrl,
  HttpConfigError,
  type Logger,
  logError,
  plaintextRedisHost,
} from '@hpmws/http';
import type { PubSubEngine } from '@leaven-graphql/ws';
import { RedisClient } from 'bun';

/** Key material: a string (its UTF-8 bytes) or bytes. */
export type RedisPubSubKey = string | Uint8Array;

/** Copies of the keys (so later changes to the caller's buffers have no effect), each >= 32 bytes. */
function keyList(
  name: string,
  value: RedisPubSubKey | readonly RedisPubSubKey[] | undefined,
): Uint8Array[] | undefined {
  if (value === undefined) return undefined;
  const list = typeof value === 'string' || value instanceof Uint8Array ? [value] : [...value];
  if (list.length === 0)
    throw new HttpConfigError(`RedisPubSub ${name} must list at least one key.`);
  return list.map((key) => {
    const bytes =
      typeof key === 'string'
        ? new TextEncoder().encode(key)
        : key instanceof Uint8Array
          ? Uint8Array.from(key)
          : undefined;
    if (!bytes || bytes.byteLength < 32) {
      throw new HttpConfigError(`RedisPubSub ${name} keys must be at least 32 bytes.`);
    }
    return bytes;
  });
}

/** Encrypted payloads: `e1.<iv>.<ciphertext + tag>`, base64url. */
const ENCRYPTED_PREFIX = 'e1.';
const ENVELOPE = /^e1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/;

/** An AES-256 key derived from key material (HKDF-SHA256, so any length >= 32 bytes works). */
function aesKey(material: Uint8Array): Buffer {
  return Buffer.from(
    hkdfSync('sha256', material, new Uint8Array(0), 'hpmws:redis-pubsub:aes-256-gcm', 32),
  );
}

/** Dropped messages are reported at most this often, in milliseconds. */
const DROP_REPORT_INTERVAL = 10_000;

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

/** Longest accepted maxSignatureAge: 10 minutes. */
const MAX_SIGNATURE_AGE = 600_000;

export interface RedisPubSubOptions {
  /**
   * Publisher connection (not closed by close()). The subscriber is always a dedicated duplicate.
   * A supplied client bypasses the plaintext (`requireTls`) check: configure TLS on it yourself.
   */
  client?: RedisClient;
  /**
   * Throw at construction when `url` (or REDIS_URL/VALKEY_URL) is a plaintext `redis://` or
   * `valkey://` URL to a non-loopback host. Without it, that only logs a warning. Default false.
   */
  requireTls?: boolean;
  /** Connection URL when no client is given (default: Bun's REDIS_URL / localhost). */
  url?: string;
  /** Channel prefix. Default 'hpmws:gql:'. */
  prefix?: string;
  /** Where failures are reported. Default: the application's LOGGER once GraphQLModule starts. */
  logger?: Logger;
  /**
   * Shared secret (at least 32 bytes) for HMAC-SHA256 message signatures over the channel
   * (prefix + topic), a millisecond timestamp and the payload. Every instance must use the same
   * key; messages without a valid signature, older than `maxSignatureAge` or dated more than 60s
   * ahead are dropped and logged. Use it when other clients can publish to the Redis server.
   * A captured message can still be replayed on the same channel inside that window. An array
   * rotates keys: messages are signed with the first and accepted under any of them. Generate
   * one with `openssl rand -base64 32` and load it from a secret store or the environment.
   */
  signingKey?: RedisPubSubKey | readonly RedisPubSubKey[];
  /**
   * Key material (at least 32 bytes, the same on every instance) for AES-256-GCM payload
   * encryption: each message gets a random 12-byte IV, and the channel (prefix + topic) is the
   * additional authenticated data, so a message cannot be replayed on another topic. Messages
   * that fail to decrypt (tampered, wrong key, not encrypted) are dropped and logged. An array
   * rotates keys: encrypt with the first, decrypt with any. Combined with `signingKey`, the
   * payload is encrypted and the envelope then signed.
   */
  encryptionKey?: RedisPubSubKey | readonly RedisPubSubKey[];
  /** Oldest signed message accepted, in milliseconds: 1 to 600000. Default 60000. */
  maxSignatureAge?: number;
  /**
   * Milliseconds a publish waits for Redis: past it, publish() logs and resolves, and
   * publishOrThrow() rejects. Default 2000. A supplied client should also set
   * `enableOfflineQueue: false` and a `connectionTimeout`, so commands fail fast while Redis is
   * unreachable instead of queueing.
   */
  publishTimeout?: number;
  /**
   * Largest message accepted, in bytes (UTF-8, after signing and encryption): larger incoming
   * messages are dropped before any HMAC, decryption or JSON work, and publishOrThrow() rejects
   * larger outgoing ones. Default 1 MiB.
   */
  maxMessageBytes?: number;
}

/**
 * Hex-encoded HMAC-SHA256 length; a signed message is `<signature>.<ts>.<payload JSON>`, the
 * MAC covering `<prefix><topic>\0<ts>\0<payload JSON>`.
 */
const SIGNATURE_LENGTH = 64;
/** Clock skew tolerated for messages dated in the future. */
const MAX_FUTURE_SKEW = 60_000;

interface Listener {
  callback: (payload: unknown) => void;
  onError: ((error: Error) => void) | undefined;
}

/**
 * PubSubEngine on Bun.redis for multi-instance deployments. Payloads are JSON. Redis requires a
 * connection in subscriber mode to do nothing else, so subscriptions use a dedicated connection.
 * If that connection or a SUBSCRIBE fails, the failure is logged, every subscriber of the topic
 * is told through its `onError` (ending its GraphQL subscription), and the next subscriber retries.
 * `publish()` never rejects (failures are logged); `publishOrThrow()` does. Connect with
 * `rediss://` and an ACL user limited to the prefix's channels in production, and set
 * `signingKey` when anything else can publish to the server.
 */
export class RedisPubSub implements PubSubEngine {
  readonly #publisher: RedisClient;
  readonly #owned: boolean;
  readonly #prefix: string;
  readonly #topics = new Map<string, Set<Listener>>();
  /**
   * Per-topic queue of Redis SUBSCRIBE/UNSUBSCRIBE calls. They run one after another, so an
   * UNSUBSCRIBE never overtakes the SUBSCRIBE it undoes (which would leave the channel
   * subscribed, and a later SUBSCRIBE would then register a second handler).
   */
  readonly #redisOps = new Map<string, Promise<void>>();
  /** Listener sets whose Redis SUBSCRIBE succeeded (and so need an UNSUBSCRIBE). */
  readonly #subscribed = new WeakSet<Set<Listener>>();
  #logger: Logger;
  #explicitLogger: boolean;
  #development = process.env.NODE_ENV === 'development';
  #subscriber: Promise<RedisClient> | undefined;
  #closed = false;
  /** Signing keys: the first signs, any verifies. */
  readonly #signingKeys: Uint8Array[] | undefined;
  /** AES-256 keys: the first encrypts, any decrypts. */
  readonly #encryptionKeys: Buffer[] | undefined;
  readonly #maxSignatureAge: number;
  readonly #publishTimeout: number;
  readonly #maxMessageBytes: number;
  /** Messages dropped since the last drop report, and when that report was logged. */
  #dropped = 0;
  #lastDropReport = Number.NEGATIVE_INFINITY;

  constructor(options: RedisPubSubOptions = {}) {
    this.#signingKeys = keyList('signingKey', options.signingKey);
    this.#encryptionKeys = keyList('encryptionKey', options.encryptionKey)?.map(aesKey);
    const maxAge = options.maxSignatureAge ?? 60_000;
    if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > MAX_SIGNATURE_AGE) {
      throw new HttpConfigError(
        `RedisPubSub maxSignatureAge must be an integer from 1 to ${MAX_SIGNATURE_AGE} (ms); got ${String(maxAge)}.`,
      );
    }
    this.#maxSignatureAge = maxAge;
    const publishTimeout = options.publishTimeout ?? 2000;
    if (!Number.isInteger(publishTimeout) || publishTimeout < 1) {
      throw new HttpConfigError(
        `RedisPubSub publishTimeout must be a positive integer (ms); got ${String(publishTimeout)}.`,
      );
    }
    this.#publishTimeout = publishTimeout;
    const maxBytes = options.maxMessageBytes ?? 1024 * 1024;
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new HttpConfigError(
        `RedisPubSub maxMessageBytes must be a positive integer; got ${String(maxBytes)}.`,
      );
    }
    this.#maxMessageBytes = maxBytes;
    this.#prefix = options.prefix ?? 'hpmws:gql:';
    this.#explicitLogger = options.logger !== undefined;
    this.#logger = options.logger ?? new ConsoleLogger('hpmws:graphql');
    const remote = plaintextRedisHost(
      options.client === undefined ? (options.url ?? defaultRedisUrl()) : undefined,
    );
    if (remote !== undefined) {
      const problem =
        `RedisPubSub connects to ${remote} over plaintext redis://, so events and credentials ` +
        'cross the network unencrypted. Use rediss:// (TLS) with an ACL user.';
      if (options.requireTls) throw new HttpConfigError(problem);
      this.#logger.warn(problem);
    }
    this.#owned = options.client === undefined;
    this.#publisher = options.client ?? new RedisClient(options.url);
  }

  /**
   * @internal GraphQLModule passes the application LOGGER (unless one was configured) and its
   * development flag.
   */
  useLogger(logger: Logger, development?: boolean): void {
    if (!this.#explicitLogger) this.#logger = logger;
    if (development !== undefined) this.#development = development;
  }

  /** Logs through logError(): a summary outside development, the redacted error in it. */
  #logError(message: string, error: unknown, level: 'error' | 'warn' = 'error'): void {
    logError({ logger: this.#logger, development: this.#development }, message, error, level);
  }

  subscribe(
    topic: string,
    callback: (payload: unknown) => void,
    onError?: (error: Error) => void,
  ): () => void {
    if (this.#closed) throw new Error('RedisPubSub is closed.');
    let listeners = this.#topics.get(topic);
    if (!listeners) {
      const created = new Set<Listener>();
      this.#topics.set(topic, created);
      this.#enqueue(topic, () => this.#redisSubscribe(topic, created));
      listeners = created;
    }
    const listener: Listener = { callback, onError };
    listeners.add(listener);
    const own = listeners;
    return () => {
      if (!own.delete(listener) || own.size > 0 || this.#topics.get(topic) !== own) return;
      this.#topics.delete(topic);
      this.#enqueue(topic, () => this.#redisUnsubscribe(topic, own));
    };
  }

  /**
   * Publishes `payload` (as JSON) and never rejects: a failure is logged, and the event is lost.
   * Use publishOrThrow() when the caller must know.
   */
  async publish(topic: string, payload: unknown): Promise<void> {
    try {
      await this.publishOrThrow(topic, payload);
    } catch (error) {
      this.#logError(`RedisPubSub failed to publish to ${JSON.stringify(topic)}`, error);
    }
  }

  /** Like publish(), but rejects when Redis did not accept the message within publishTimeout. */
  async publishOrThrow(topic: string, payload: unknown): Promise<void> {
    const json = JSON.stringify(payload);
    if (json === undefined) throw new TypeError('RedisPubSub payloads must be JSON-serializable.');
    // Encrypt, then sign the envelope.
    let message = this.#encryptionKeys ? this.#encrypt(topic, json) : json;
    if (this.#signingKeys) {
      const ts = String(Date.now());
      message = `${this.#sign(this.#signingKeys[0]!, topic, ts, message)}.${ts}.${message}`;
    }
    if (byteLength(message) > this.#maxMessageBytes) {
      throw new RangeError(
        `RedisPubSub message for ${JSON.stringify(topic)} is larger than maxMessageBytes (${this.#maxMessageBytes}).`,
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#publisher.publish(this.#prefix + topic, message),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Redis did not answer within ${this.#publishTimeout}ms`)),
            this.#publishTimeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #sign(key: Uint8Array, topic: string, ts: string, json: string): string {
    return createHmac('sha256', key)
      .update(`${this.#prefix}${topic}\0${ts}\0${json}`)
      .digest('hex');
  }

  /** The payload JSON of a correctly signed, fresh message, or undefined. */
  #verified(topic: string, message: string): string | undefined {
    if (message[SIGNATURE_LENGTH] !== '.') return undefined;
    const dot = message.indexOf('.', SIGNATURE_LENGTH + 1);
    if (dot < 0) return undefined;
    const ts = message.slice(SIGNATURE_LENGTH + 1, dot);
    if (!/^\d{1,16}$/.test(ts)) return undefined;
    const age = Date.now() - Number(ts);
    if (age > this.#maxSignatureAge || age < -MAX_FUTURE_SKEW) return undefined;
    const json = message.slice(dot + 1);
    const given = Buffer.from(message.slice(0, SIGNATURE_LENGTH), 'utf8');
    if (given.length !== SIGNATURE_LENGTH) return undefined;
    let valid = false;
    // Every key is tried (no early exit), so the time does not reveal which one matched.
    for (const key of this.#signingKeys!) {
      const expected = Buffer.from(this.#sign(key, topic, ts, json), 'utf8');
      if (timingSafeEqual(given, expected)) valid = true;
    }
    return valid ? json : undefined;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#topics.clear();
    const subscriber = this.#subscriber;
    this.#subscriber = undefined;
    const client = await subscriber?.catch(() => undefined);
    if (client) {
      // Bun keeps the process alive after closing a client that is still in subscriber mode.
      // unsubscribe() throws synchronously when the client is not in subscriber mode.
      try {
        if (client.connected) await client.unsubscribe();
      } catch {
        // Nothing was subscribed, or the connection is gone: close() below is enough.
      }
      client.close();
    }
    if (this.#owned) this.#publisher.close();
  }

  /** Verifies, decrypts and parses a message, then hands the payload to the topic's listeners. */
  #receive(topic: string, message: string): void {
    // Size first: forged messages must not cost an HMAC, a decryption or a JSON parse.
    if (message.length > this.#maxMessageBytes || byteLength(message) > this.#maxMessageBytes) {
      this.#drop(topic, `larger than ${this.#maxMessageBytes} bytes`);
      return;
    }
    let body: string | undefined = message;
    if (this.#signingKeys) {
      body = this.#verified(topic, message);
      if (body === undefined) {
        this.#drop(topic, 'no valid signature (forged, stale or signed with another key)');
        return;
      }
    }
    let json = body;
    if (this.#encryptionKeys) {
      try {
        json = this.#decrypt(topic, body);
      } catch (error) {
        this.#drop(topic, 'failed to decrypt', error);
        return;
      }
    }
    let payload: unknown;
    try {
      payload = JSON.parse(json);
    } catch {
      this.#drop(topic, 'not JSON');
      return;
    }
    for (const listener of this.#topics.get(topic) ?? []) {
      try {
        listener.callback(payload);
      } catch (error) {
        this.#logError(`RedisPubSub listener for ${JSON.stringify(topic)} threw`, error);
      }
    }
  }

  /**
   * Counts a dropped message and logs at most one report per 10s per instance, with the number
   * dropped since the previous report, so a flood of forged messages cannot flood the log.
   */
  #drop(topic: string, reason: string, error?: unknown): void {
    this.#dropped++;
    const now = Date.now();
    if (now - this.#lastDropReport < DROP_REPORT_INTERVAL) return;
    const count = this.#dropped;
    this.#dropped = 0;
    this.#lastDropReport = now;
    const message =
      `RedisPubSub dropped ${count} message(s) since the last report; the latest on ` +
      `${JSON.stringify(topic)}: ${reason}`;
    if (error === undefined) this.#logger.warn(message);
    else this.#logError(message, error, 'warn');
  }

  /** `e1.<iv>.<ciphertext + tag>` (base64url), AES-256-GCM with the channel as AAD. */
  #encrypt(topic: string, json: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#encryptionKeys![0]!, iv);
    cipher.setAAD(Buffer.from(this.#prefix + topic, 'utf8'));
    const sealed = Buffer.concat([
      cipher.update(json, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return `${ENCRYPTED_PREFIX}${iv.toString('base64url')}.${sealed.toString('base64url')}`;
  }

  /** The plaintext of an envelope sealed under any of the keys, for this channel; or throws. */
  #decrypt(topic: string, body: string): string {
    const match = ENVELOPE.exec(body);
    if (!match) throw new Error('The message is not an encrypted envelope.');
    const iv = Buffer.from(match[1]!, 'base64url');
    const sealed = Buffer.from(match[2]!, 'base64url');
    if (iv.length !== 12 || sealed.length < 16) throw new Error('Malformed encrypted envelope.');
    const tag = sealed.subarray(sealed.length - 16);
    const ciphertext = sealed.subarray(0, sealed.length - 16);
    for (const key of this.#encryptionKeys!) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(this.#prefix + topic, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        // Wrong key, or tampered: try the next key.
      }
    }
    throw new Error('No encryption key authenticates the message.');
  }

  /** Runs `op` after the topic's earlier Redis calls; `op` handles its own errors. */
  #enqueue(topic: string, op: () => Promise<void>): void {
    const next = (this.#redisOps.get(topic) ?? Promise.resolve()).then(op);
    this.#redisOps.set(topic, next);
    void next.then(() => {
      if (this.#redisOps.get(topic) === next) this.#redisOps.delete(topic);
    });
  }

  async #redisUnsubscribe(topic: string, listeners: Set<Listener>): Promise<void> {
    // Nothing to undo when the SUBSCRIBE failed.
    const subscriber = this.#subscriber;
    if (this.#closed || !subscriber || !this.#subscribed.delete(listeners)) return;
    try {
      await (await subscriber).unsubscribe(this.#prefix + topic);
    } catch (error) {
      if (!this.#closed)
        this.#logError(
          `RedisPubSub failed to unsubscribe from ${JSON.stringify(topic)}`,
          error,
          'warn',
        );
    }
  }

  #subscriberClient(): Promise<RedisClient> {
    if (!this.#subscriber) {
      const pending = this.#publisher.duplicate();
      this.#subscriber = pending;
      // A failed connection is not cached: the next subscribe() tries again.
      pending.catch(() => {
        if (this.#subscriber === pending) this.#subscriber = undefined;
      });
    }
    return this.#subscriber;
  }

  async #redisSubscribe(topic: string, listeners: Set<Listener>): Promise<void> {
    if (this.#closed) return;
    try {
      const subscriber = await this.#subscriberClient();
      await subscriber.subscribe(this.#prefix + topic, (message) => this.#receive(topic, message));
      this.#subscribed.add(listeners);
    } catch (error) {
      if (this.#closed) return;
      this.#logError(`RedisPubSub failed to subscribe to ${JSON.stringify(topic)}`, error);
      if (this.#topics.get(topic) === listeners) this.#topics.delete(topic);
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const listener of listeners) listener.onError?.(failure);
    }
  }
}
