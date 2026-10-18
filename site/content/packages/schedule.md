---
title: @knead-js/schedule
description: API reference for @knead-js/schedule, the cron, interval and timeout job scheduler with optional distributed locking.
---

```bash
bun add @knead-js/core @knead-js/schedule
```

`@knead-js/core` is a peer dependency. The package depends on
[croner](https://github.com/hexagon/croner) 10.0.1 (pinned exactly) to compute cron times.
`RedisLockStore` uses Bun's built-in `RedisClient`, so Redis needs no extra package.

The package runs methods of your providers on a schedule: `ScheduleModule.forRoot()` discovers
methods decorated with `@Cron()`, `@Interval()` and `@Timeout()` in every module at bootstrap,
arms their timers, and drains them at shutdown. `SchedulerRegistry` controls jobs at runtime, and a
lock store keeps each cron firing to one instance. The [scheduling guide](/guide/scheduling/)
explains the concepts with complete examples.

## `ScheduleModule`

`ScheduleModule.forRoot(options?: ScheduleModuleOptions): DynamicModule` returns a global module
that provides and exports `SchedulerRegistry` and `SCHEDULE_OPTIONS`. Import it once, in the root
module: a second import fails at bootstrap with `ScheduleConfigError`. Options are validated when
`forRoot()` is called, so a mistake throws `ScheduleConfigError` before the application starts.

### `ScheduleModuleOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `lockStore` | `ScheduleLockStore` | none | Required by any job with `lock`; bootstrap fails without it. Must have an `acquire()` method. |
| `lockTtl` | `Duration` | `'60s'` | Lock TTL for jobs with `lock: true`. Must exceed clock skew between instances. |
| `onError` | `(error: unknown, ctx: JobContext) => unknown` | `logger.error` with a redacted summary | Receives every failed run and every lock store error. May be async. |
| `shutdownTimeout` | `Duration` | `'10s'` | How long shutdown waits for runs in progress before logging their names and continuing. |
| `enabled` | `boolean` | `true` | `false` registers every job paused; `trigger()` and `resume()` still work. |
| `logger` | `ScheduleLogger` | the application's `LOGGER` | Receives the scheduler's warnings and the default `onError` reports, always as single redacted strings with control characters in job names escaped (`\n`), so a runtime job name cannot forge log lines. |

The default `onError` logs `[knead:schedule] Job "<name>" failed: <Name>: <message>` through
`logger.error`, where the message is redacted and capped at 500 characters, with no stack, cause or
properties. An `onError` that throws is caught and logged as
`[knead:schedule] onError failed for job "<name>": <summary>`.

### `ScheduleLogger`

The part of a logger the scheduler uses: an object with `warn(message: string, ...meta: unknown[]): void`
and `error(message: string, ...meta: unknown[]): void`. Every Knead `Logger` (for example
`ConsoleLogger`) fits.

### `SCHEDULE_OPTIONS`

`InjectionToken<ScheduleModuleOptions>` holding the options passed to `forRoot()`, as given (not
resolved with defaults).

## Decorators

All three decorate instance methods. Static methods throw `ScheduleConfigError` when the class is
defined, as do invalid patterns, time zones, durations and names. The method receives a
`JobContext` and may return a promise. The job's name defaults to `ClassName.methodName`.

### `@Cron()`

`Cron(pattern: string, options?: CronOptions)` runs the method on a cron pattern: 5 fields, or 6
with seconds first, an optional 7th field for the year, and macros such as `@daily` and `@hourly`.
See [cron patterns](/guide/scheduling/#cron-patterns). A pattern longer than 1024 characters
is a `ScheduleConfigError`, which bounds the work for runtime patterns that come from tenant data.

Across daylight saving time changes in `timezone`:

- **Spring forward.** A time in the skipped hour runs at the same minutes in the hour after:
  `30 2 * * *` in `America/New_York` runs at 03:30 EDT on the day 02:00 jumps to 03:00, then at
  02:30 again.
- **Fall back.** A time in the repeated hour runs once, in its first occurrence: `30 1 * * *`
  runs at 01:30 EDT and not again at 01:30 EST. A job armed during the second occurrence (started,
  resumed or added then) skips the rest of it too and runs at its first match after the repeated
  hour, so every instance computes the same firings and a `lock: true` job runs once.

`CronOptions` extends `JobOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | `'ClassName.methodName'` | Unique job name; must be a non-empty string. |
| `timezone` | `string` | the process time zone | IANA time zone the pattern is evaluated in. |
| `lock` | `boolean \| { ttl: Duration }` | `false` | Run each firing on one instance only, through the module's `lockStore`. `true` uses `lockTtl`; `{ ttl }` sets this job's TTL. |

### `@Interval()`

`Interval(every: Duration, options?: JobOptions)` runs the method every `every`. The first run is
one period after the application starts. Later runs are timed from the schedule, not from the end
of the previous run.

### `@Timeout()`

`Timeout(after: Duration, options?: JobOptions)` runs the method once, `after` the application
starts. The job is listed as `stopped` while its run is in progress and leaves the registry when the
run settles (unless it was resumed or replaced meanwhile, including by the handler itself before
its first `await`).

### `JobOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | `'ClassName.methodName'` | Unique job name; must be a non-empty string. |

## Job types

### `JobContext`

| Property | Type | Description |
| --- | --- | --- |
| `name` | `string` | The job's name. |
| `signal` | `AbortSignal` | Aborted when the application starts shutting down. |
| `scheduledAt` | `Date` | The time this run was scheduled for; the trigger time for manual runs. |
| `trigger` | `'schedule' \| 'manual'` | `'manual'` for runs started by `SchedulerRegistry.trigger()`. |

### `JobHandler`

`type JobHandler = (ctx: JobContext) => unknown`. The function type the registry's `add*()`
methods take. A returned promise is awaited; a throw or rejection goes to `onError`.

## `SchedulerRegistry`

Injectable from any module. Decorated jobs are registered and started in its
`onApplicationBootstrap` hook. Its `beforeApplicationShutdown` hook stops every timer, aborts every
`JobContext.signal` and waits up to `shutdownTimeout` for runs in progress.

| Method | Description |
| --- | --- |
| `list(): JobInfo[]` | Every registered job. |
| `get(name: string): JobInfo \| undefined` | One job, or `undefined`. |
| `addCron(name, pattern, handler, options?)` | Adds a cron job. `options` is `CronOptions` without `name` (`timezone`, `lock`). |
| `addInterval(name, every, handler)` | Adds an interval job. |
| `addTimeout(name, after, handler)` | Adds a one-shot job. |
| `pause(name): void` | Disarms the job. |
| `resume(name): void` | Re-arms a paused or stopped job from now; missed firings do not run. A no-op for a scheduled job. |
| `trigger(name): Promise<void>` | Runs the job now, without its lock. Resolves when the run settles; failures go to `onError`. |
| `remove(name): boolean` | Disarms and forgets the job; runs in progress finish. `false` if there was no such job. |

`name` is a `string`, `pattern` a `string`, `handler` a `JobHandler`, and `every` and `after` are
`Duration`s. Jobs added before bootstrap start with the decorated ones; jobs added later start
immediately (paused if `enabled` is `false`).

Errors: an unknown name throws `ScheduleJobNotFoundError` from `pause()`, `resume()` and
`trigger()` (`remove()` returns `false`). A duplicate or empty name, a handler that is not a
function, an invalid pattern or duration, `lock` without a `lockStore`, and any change after
shutdown (`remove()` included) throw `ScheduleConfigError`.

### `JobInfo`

A snapshot of one job:

| Property | Type | Description |
| --- | --- | --- |
| `name` | `string` | The job's name. |
| `kind` | `JobKind` | `'cron'`, `'interval'` or `'timeout'`. |
| `state` | `JobState` | `'scheduled'`, `'paused'` or `'stopped'`. |
| `nextRunAt` | `Date \| undefined` | The next run. `undefined` while paused or stopped, and before the application has started. |
| `running` | `number` | Runs in progress. Runs may overlap, so this can exceed 1. |

### `JobState`

`type JobState = 'scheduled' | 'paused' | 'stopped'`. A job is `stopped` after a timeout has fired,
when a cron pattern has no future match, and for every job after shutdown.

### `JobKind`

`type JobKind = 'cron' | 'interval' | 'timeout'`.

## Lock stores

### `ScheduleLockStore`

The interface a lock store implements:

| Member | Type | Description |
| --- | --- | --- |
| `acquire` | `(key: string, ttlMs: number) => Promise<boolean>` | Claims `key` for `ttlMs` milliseconds. |
| `close` | `() => void \| Promise<void>` (optional) | Releases the store's connections. |
| `setLogger` | `(logger: WarnLogger) => void` (optional) | Called once when `ScheduleModule` starts, with the scheduler's logger (the `logger` option, or the application's `LOGGER`), for a store built outside dependency injection. |

`acquire()` must resolve `true` for exactly one caller per key until `ttlMs` has passed. The
scheduler calls it with `<job name>:<scheduled time in epoch ms>` and never releases a lock. If
`acquire()` rejects, the firing is skipped and the error goes to `onError`. The scheduler never
calls `close()`; close the store yourself at shutdown.

### `MemoryLockStore`

`new MemoryLockStore()` keeps locks in a `Map` in this process, so it deduplicates only between
schedulers in one process. Expired entries are swept every 256 acquires. `acquire()` rejects with
`ScheduleConfigError` unless `ttlMs` is an integer of at least 1.

### `RedisLockStore`

`new RedisLockStore(options?: RedisLockStoreOptions)` shares locks between every instance using the
same Redis or Valkey. Each `acquire()` sends `SET <prefix><key> 1 NX PX <ttlMs>` and resolves `true`
when Redis answers `OK`. Keys expire on their own and are never deleted. It connects on first use.

### `RedisLockStoreOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | Bun's default (`REDIS_URL`, `VALKEY_URL`, then `redis://localhost:6379`) | Connection URL when no `client` is given. |
| `client` | `RedisClient` (from `bun`) | none | An existing client. It is not closed by `close()` and skips the plaintext check. Pass `client` or `url`, not both. |
| `prefix` | `string` | `'knead:schedule:'` | Key prefix. |
| `requireTls` | `boolean` | `false` | Throw `ScheduleConfigError` at construction instead of warning when the URL is plaintext to a non-loopback host. |
| `logger` | `WarnLogger` | the scheduler's logger | Where the plaintext warning goes. Without it, the warning is held until `ScheduleModule` starts and passes its logger (`setLogger()`); a store used without the module sends it to a `ConsoleLogger` from `@knead-js/core` at its first `acquire()`. |
| `commandTimeout` | `number` | `250` | Milliseconds an `acquire()` waits for Redis before rejecting; must be an integer of at least 1. |

URL safety: when `url` (or `REDIS_URL`, then `VALKEY_URL`, if neither `url` nor `client` is given)
is a plaintext `redis://` or `valkey://` URL to a host other than `localhost`, `127.0.0.0/8` or
`::1`, the constructor logs
`[knead:schedule] RedisLockStore connects to <host:port> over plaintext redis://, so credentials cross the network unencrypted. Use rediss:// (TLS) with an ACL user.`,
or throws that message as `ScheduleConfigError` with `requireTls: true`. The message never
includes the URL's credentials. `rediss://`, `valkeys://` and Unix socket URLs pass.

The store creates its own client with `enableOfflineQueue: false`, so a command that timed out is
never sent later, and a `connectionTimeout` of `max(commandTimeout, 1000)` ms
(`ownedRedisClientOptions()` from `@knead-js/core`), and connects it before sending. A `client`
you pass is never connected by the store: create it with the same settings and connect it
yourself. `close()` closes a client the store created and does nothing for a supplied one.

Passing both `client` and `url` throws
`ScheduleConfigError` (`Pass either client or url to RedisLockStore, not both.`).

## Durations

### `Duration`

``type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}` ``: milliseconds, or a
string such as `'500ms'`, `'1.5s'`, `'10m'`, `'1h'` or `'1d'`.

### `parseDuration()`

`parseDuration(value: Duration | string, label?: string): number` returns whole milliseconds,
rounded up and at least 1. It throws `ScheduleConfigError` for a malformed string, a value that is
not positive or not finite, and anything over a year. `label` (default `'duration'`) names the
value in the error message, for example `Invalid lockTtl 366d: must be at most one year (365d).`

### `MAX_DURATION_MS`

`31_536_000_000`: the longest accepted duration, 365 days in milliseconds.

## Errors

Both extend `KneadError` from `@knead-js/core`, and their `name` is the class name.

### `ScheduleConfigError`

An invalid job, schedule or option, a duplicate job name, a second `forRoot()` import, jobs on a
transient or `multi` class provider, `lock` without a `lockStore`, or a change
made after the scheduler shut down. Thrown when a decorator is evaluated, when `forRoot()` is
called, at bootstrap, or by a registry method.

### `ScheduleJobNotFoundError`

Thrown by `pause()`, `resume()` and `trigger()` for an unknown name. Its `jobName` property holds
the name, and its message is `No scheduled job named "<name>".`
