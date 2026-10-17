# @knead-js/schedule

[![npm](https://img.shields.io/npm/v/@knead-js/schedule?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/schedule)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

Cron, interval and timeout jobs for Knead applications. Decorate methods of ordinary providers, and
the scheduler starts them at bootstrap, stops them at shutdown, and can keep each cron firing to
one instance across replicas.

**[Documentation](https://quinnjr.github.io/knead/packages/schedule/)** · [Guide](https://quinnjr.github.io/knead/guide/scheduling/) · [Knead](https://github.com/quinnjr/knead)

## Install

```bash
bun add @knead-js/core @knead-js/schedule
```

Requires Bun 1.4.3 or newer. `@knead-js/core` is a peer dependency. Cron times are computed by
[croner](https://github.com/hexagon/croner) (pinned exactly), and `RedisLockStore` uses Bun's
built-in Redis client, so Redis needs no extra package.

## Quick start

```ts
import { inject, Module } from '@knead-js/core';
import { Cron, Interval, type JobContext, ScheduleModule, Timeout } from '@knead-js/schedule';

export class ReportService {
  readonly built: string[] = [];

  async build(day: Date, signal: AbortSignal): Promise<void> {
    // Pass `signal` to fetch and database calls so shutdown can cancel them.
    signal.throwIfAborted();
    this.built.push(day.toISOString());
  }

  async warmCache(): Promise<void> {}
}

export class ReportJobs {
  readonly reports = inject(ReportService);

  // 03:00 every day, New York time.
  @Cron('0 3 * * *', { name: 'nightly-report', timezone: 'America/New_York' })
  async nightly({ scheduledAt, signal }: JobContext) {
    await this.reports.build(scheduledAt, signal);
  }

  // Every 30 seconds, starting 30 seconds after startup. Named 'ReportJobs.heartbeat'.
  @Interval('30s')
  heartbeat() {}

  // Once, 5 seconds after startup.
  @Timeout('5s', { name: 'warm-cache' })
  async warmCache() {
    await this.reports.warmCache();
  }
}

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [ReportService, ReportJobs],
})
export class AppModule {}
```

`ScheduleModule.forRoot()` finds the decorated methods on the providers of every module when the
application bootstraps and arms their timers. When the application closes, it stops the timers,
aborts `signal` and waits for runs in progress.

## Features

- **Three decorators.** `@Cron()`, `@Interval()` and `@Timeout()` on instance methods of any
  singleton class provider.
- **Fails early.** Cron patterns, time zones, durations and names are validated when the decorator
  runs, so a typo fails at import, not at 3 a.m.
- **No drift.** Runs are timed from the schedule, not from the end of the previous run.
- **Errors never stop a job.** A failing run goes to `onError`; the default logs a redacted
  one-line summary, never a raw error object.
- **One instance per firing.** With a lock store, a cron job with `lock: true` runs once per firing
  across all replicas, and a store outage skips the firing rather than running it twice.
- **Runtime control.** `SchedulerRegistry` lists, pauses, resumes, triggers, adds and removes jobs.
- **Graceful shutdown.** Timers stop, `signal` aborts and shutdown waits up to `shutdownTimeout`
  for runs in progress.

## Declaring jobs

- `@Cron(pattern, { name?, timezone?, lock? })` runs on a cron pattern: 5 fields, or 6 with seconds
  first, an optional 7th for the year, and macros such as `@daily` and `@hourly`. `timezone` is an
  IANA name; the default is the process time zone. Patterns are at most 1024 characters. Across
  daylight saving time changes, a time in the skipped hour runs an hour later that day, and a time
  in the repeated hour runs once, in its first occurrence (an instance started during the second
  occurrence skips it too, so a locked job cannot run twice).
- `@Interval(every, { name? })` runs every `every`. The first run is one period after startup.
- `@Timeout(after, { name? })` runs once. While that run is in progress the job is listed as
  `stopped`; when it settles, the job leaves the registry.

Durations are milliseconds or strings such as `'500ms'`, `'30s'`, `'10m'`, `'1h'` and `'1d'`, at
most one year (`'365d'`).

Every handler receives a `JobContext`: `{ name, signal, scheduledAt, trigger }`. `signal` aborts
when the application starts shutting down, and `trigger` is `'schedule'` or `'manual'`. Handlers are
plain method calls, so call `inject()` in field initializers, never inside the handler.

Rules to keep in mind:

- Import `ScheduleModule.forRoot()` once, in the root module. A second import fails at bootstrap
  instead of running every job twice.
- A class that no module lists as a provider is never instantiated, so its jobs never run.
  `SchedulerRegistry.list()` shows what was registered.
- Jobs on a `transient` provider fail at bootstrap. A class provided by several modules registers
  its jobs once.
- Job names default to `ClassName.methodName` and must be unique. Minifiers rename classes, so give
  jobs explicit names in minified builds.
- **Runs may overlap.** A tick starts a new run even if the previous one is still going; guard
  against that in the job if it matters. Missed firings (a suspended process, a blocked event loop)
  are not caught up.

## Errors

A run that throws or rejects goes to `onError(error, ctx)` and the job keeps its schedule. The
default `onError` writes one line through `logger.error`:

```text
[knead:schedule] Job "sync" failed: Error: connect redis://***@cache:6379 refused
```

That summary masks credentials in URLs and `key=value` pairs, is capped at 500 characters, and
leaves out the stack, cause and other properties. A custom `onError` receives the raw error, so
redact what you log there (`summarizeError()` from `@knead-js/core` gives the same summary).

## Running a cron job on one instance

By default every process runs every job. With several replicas, give `forRoot()` a `lockStore` and
set `lock` on the cron jobs that must run once per firing:

```ts
const lockStore = new RedisLockStore({
  url: process.env.REDIS_URL,
  // Refuse a plaintext redis:// URL to a remote host instead of only warning.
  requireTls: true,
});

export class BillingJobs {
  // Every replica fires at 02:00 UTC; only the one that claims the firing runs it.
  @Cron('0 2 * * *', { name: 'charge-renewals', timezone: 'UTC', lock: true })
  async chargeRenewals() {}

  // A per-job TTL for the claim.
  @Cron('*/5 * * * *', { name: 'retry-failed-charges', lock: { ttl: '2m' } })
  async retryFailedCharges() {}
}

// The scheduler never closes a lock store. onModuleDestroy runs after the scheduler has
// drained its runs in beforeApplicationShutdown.
class LockStoreLifecycle implements OnModuleDestroy {
  onModuleDestroy() {
    return lockStore.close();
  }
}

@Module({
  imports: [ScheduleModule.forRoot({ lockStore, lockTtl: '90s' })],
  providers: [BillingJobs, LockStoreLifecycle],
})
export class AppModule {}
```

- Each firing is claimed under `<job name>:<scheduled time>`, a key every instance computes the
  same way. The first instance to claim it runs the job; the others skip that firing.
- Locks are never released; they expire after the TTL (`lockTtl`, default 60 seconds, or the job's
  `lock: { ttl }`). The TTL must exceed the clock skew and timer lateness between instances, not
  the job's run time.
- **The lock fails closed.** If the store errors or does not answer within `commandTimeout`
  (default 250 ms), the firing is skipped and the error goes to `onError`.
- A job with `lock` and no `lockStore` fails at bootstrap. `trigger()` ignores locks. Intervals and
  timeouts run per process and cannot be locked.

Two stores ship with the package: `RedisLockStore` (one `SET key 1 NX PX ttl` per firing, shared
through Redis or Valkey) and `MemoryLockStore` (deduplicates only within one process: for tests, or a process that runs several
applications).

### Securing the Redis connection

- Use a `rediss://` (TLS) URL and a least-privilege ACL user:
  `ACL SETUSER scheduler on >long-random-password resetkeys ~knead:schedule:* -@all +set`.
- A plaintext `redis://` or `valkey://` URL to a non-loopback host logs a warning without the
  credentials, and throws `ScheduleConfigError` with `requireTls: true`.
- A `client` you pass yourself skips that check and is never closed by the store. Create it with
  `enableOfflineQueue: false`, as the store does for its own client, so a timed-out command is
  never sent later.

## Managing jobs at runtime

Inject `SchedulerRegistry` to manage jobs while the application runs, for example to schedule one
cron job per tenant.

- `addCron(name, pattern, handler, { timezone?, lock? })`, `addInterval(name, every, handler)` and
  `addTimeout(name, after, handler)` add a job. Jobs added before bootstrap start with the
  decorated ones; jobs added later start immediately.
- `remove(name)` disarms and forgets a job and returns whether it existed; runs in progress finish.
  Like every change, it throws `ScheduleConfigError` after shutdown.
- `list()` and `get(name)` return `JobInfo` snapshots: `name`, `kind`, `state`, `nextRunAt` and
  `running` (runs in progress).
- `pause(name)` disarms a job; `resume(name)` re-arms it from now, so missed firings do not run.
- `trigger(name)` runs a job now, without its lock, and resolves when the run settles.
- Unknown names throw `ScheduleJobNotFoundError`. Invalid jobs, duplicate names and changes after
  shutdown throw `ScheduleConfigError`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `lockStore` | none | Required by any job with `lock`; bootstrap fails without it. |
| `lockTtl` | `'60s'` | Lock TTL for jobs with `lock: true`. |
| `onError` | redacted `logger.error` | Receives every failed run and every lock store error. |
| `shutdownTimeout` | `'10s'` | How long shutdown waits for runs in progress before logging their names and continuing. |
| `enabled` | `true` | `false` registers every job paused (web-only replicas, tests); `trigger()` and `resume()` still work. |
| `logger` | the application's `LOGGER` | Receives the scheduler's warnings and the default error reports, with control characters in job names escaped. Any Knead `Logger` fits. |

Options are validated when `forRoot()` is called, so a mistake throws `ScheduleConfigError` before
the application starts.

## Shutdown and testing

Knead runs every `beforeApplicationShutdown` hook, where the scheduler drains its runs, before any
`onModuleDestroy` hook. Close the connections your jobs use in `onModuleDestroy`, and jobs finish
before those connections close. Call `app.enableShutdownHooks()` so SIGTERM and SIGINT close the
application gracefully.

In tests, pass `enabled: false` so every job is registered paused, and run jobs with
`registry.trigger(name)`, which resolves when the run has settled. Nothing depends on real time.

## Documentation

- [Scheduling guide](https://quinnjr.github.io/knead/guide/scheduling/): cron patterns, timing and
  overlap, locks, shutdown and testing, with complete examples.
- [`@knead-js/schedule` reference](https://quinnjr.github.io/knead/packages/schedule/): every
  export, option and error message.
- [Lifecycle](https://quinnjr.github.io/knead/guide/lifecycle/): the order of bootstrap and
  shutdown hooks.

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
