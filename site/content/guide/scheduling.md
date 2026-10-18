---
title: Scheduling
description: Run methods of your providers on a cron pattern, at a fixed interval or once after startup, and keep each cron firing to one instance when you run several replicas.
---

`@knead-js/schedule` turns methods of ordinary providers into scheduled jobs. You decorate a method
with `@Cron()`, `@Interval()` or `@Timeout()`, import `ScheduleModule.forRoot()` once, and the
module finds the jobs when the application bootstraps, starts their timers, and stops them when
the application shuts down. The [package reference](/packages/schedule/) lists every export.

```bash
bun add @knead-js/schedule
```

## Declaring jobs

A job is a method on a class provider. It can use anything the class injects:

<<< schedule/report-jobs.ts#service title="report.service.ts"

<<< schedule/report-jobs.ts#jobs title="report.jobs.ts"

Then import `ScheduleModule.forRoot()` in the root module and list the job class as a provider:

<<< schedule/report-jobs.ts#module title="app.module.ts"

The three decorators:

- `@Cron(pattern, options?)` runs on a cron pattern. See [cron patterns](#cron-patterns).
- `@Interval(every, options?)` runs every `every`. The first run is one period after the
  application starts, not at startup.
- `@Timeout(after, options?)` runs once, `after` the application starts. While that run is in
  progress the job is listed with state `stopped`; when it settles, the job leaves the registry.

`every` and `after` are [durations](#durations): a number of milliseconds or a string such as
`'30s'`.

### Job names

Every job has a name, unique across the application. The default is `ClassName.methodName`, so the
interval above is `ReportJobs.heartbeat`. Pass `name` to choose your own, as `nightly-report` and
`warm-cache` do. Two jobs with the same name fail at bootstrap with `ScheduleConfigError`
(`A scheduled job named "same" already exists.`).

> [!TIP]
> Minifiers rename classes, which changes default names between builds. Give jobs explicit names
> if you minify your server code, and wherever other code refers to a job by name (for example
> `registry.trigger('nightly-report')`).

### Which classes are scanned

Jobs are discovered on class providers (`useClass`, or the class itself in `providers`) of every
module in the application, not only the root module. Keep these rules in mind:

- A class that no module lists as a provider is never instantiated, so its jobs never run.
  `SchedulerRegistry.list()` shows what was registered.
- The provider must be a singleton. Jobs on a `transient` provider fail at bootstrap with
  `ScheduleConfigError`.
- Jobs on a `multi: true` class provider fail at bootstrap with `ScheduleConfigError` too: the
  multi token resolves to an array of every entry, not to the class's own instance. List the
  class as a provider of its own and add it to the multi token with `useExisting`.
- A class provided by several modules registers its jobs once, on the first module's instance.
- Subclasses inherit their parent's jobs. An override that is decorated again replaces the
  parent's jobs for that method; an undecorated override keeps the parent's schedule and runs the
  override.
- The decorators work on instance methods only. On a static method they throw
  `ScheduleConfigError` when the class is defined.

Handlers are plain method calls, so call `inject()` in field initializers as usual, never inside
the handler.

### Importing the module once

`ScheduleModule.forRoot()` returns a global module. Import it once, in the root module. A second
import would run every job twice, so bootstrap fails instead with
`ScheduleModule.forRoot() is imported more than once; import it once, in the root module.`

## Cron patterns

`@Cron()` evaluates patterns with [croner](https://github.com/hexagon/croner) (version 10.0.1).
croner only computes the next time; Knead's own timers run the job.

- 5 fields: minute, hour, day of month, month, day of week (`'0 3 * * *'` is 03:00 daily).
- 6 fields: seconds first (`'*/10 * * * * *'` is every 10 seconds).
- An optional 7th field is the year.
- Macros: `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly`.
- croner extensions such as `L` (last day of the month) and `5#2` (the second Friday) work too.

Patterns are evaluated in the process time zone unless you pass `timezone`, an IANA name such as
`'America/New_York'` or `'UTC'`. Set it for anything tied to a wall-clock time: servers often run
in UTC while the business runs elsewhere, and daylight saving time moves UTC offsets twice a year.

The pattern and the time zone are validated when the decorator runs, so a typo fails when the
module is imported, not at 3 a.m. The error is a `ScheduleConfigError` such as
`Invalid cron pattern "61 * * * *": ...` or, for a bad zone,
`Invalid cron pattern "0 3 * * *" in timezone "Mars/Olympus": ...`.

A pattern that is valid but never matches again (`'0 0 31 2 *'`, February 31) is registered and
immediately stopped, with the warning `[knead:schedule] Job "feb-31" has no future run and was
stopped.`

## Durations

Wherever the package takes a duration (`@Interval`, `@Timeout`, `lock.ttl`, `lockTtl`,
`shutdownTimeout`, `addInterval`, `addTimeout`) you can pass:

- a number of milliseconds: `1500`;
- a string of a number and a unit `ms`, `s`, `m`, `h` or `d`: `'500ms'`, `'1.5s'`, `'10m'`, `'1h'`,
  `'1d'`. Surrounding whitespace is ignored, a space between number and unit is not allowed.

The value must be positive and at most one year (`'365d'`, `MAX_DURATION_MS`). It is rounded up
to whole milliseconds, and to at least 1. Anything else throws `ScheduleConfigError`, for example
`Invalid interval "soon" (use e.g. 500ms, 15s, 1m, 1h, 1d).` `parseDuration()` is exported if you
want the same parsing for your own settings.

## The job context

Every handler receives a `JobContext`:

| Property | Type | Description |
| --- | --- | --- |
| `name` | `string` | The job's name. |
| `signal` | `AbortSignal` | Aborted when the application starts shutting down. Pass it to `fetch`, database calls and loops. |
| `scheduledAt` | `Date` | The time this run was scheduled for. For a manual run, the time it was triggered. |
| `trigger` | `'schedule' \| 'manual'` | `'manual'` for runs started with `SchedulerRegistry.trigger()`. |

Use `scheduledAt` rather than `new Date()` when the run works on a period ("yesterday's
orders"): it does not depend on how late the timer fired, and for a cron job it is the same on
every instance.

## Timing and overlap

Runs are timed from the schedule, not from the end of the previous run, so a slow job does not
drift. An interval job scheduled every 30 seconds starting at 12:00:00 runs at 12:00:30, 12:01:00
and so on, however long each run takes.

> [!IMPORTANT]
> Runs may overlap. When a run is still going at the next tick, a second run starts anyway. The
> scheduler never waits for, skips or queues a run because of a previous one. If overlapping runs
> would be a problem, guard against them in the job.

A simple guard is a flag on the instance:

<<< schedule/overlap.ts#overlap title="inventory.jobs.ts"

`JobInfo.running` reports how many runs of a job are in progress.

When the process was suspended or the event loop was blocked past several ticks, the job runs
once when the timer finally fires and continues from the current time. Missed firings are not
caught up.

## Errors

A run that throws or rejects never stops its job: the next tick runs as usual. The error goes to
the module's `onError(error, ctx)`. The default `onError` writes one line through
`logger.error`:

```text
[knead:schedule] Job "sync" failed: Error: connect redis://***@cache:6379 refused
```

That line is a redacted `Name: message` summary: credentials in URLs and `key=value` pairs are
masked, the message is capped at 500 characters, and the stack, cause and other properties are
left out. The scheduler only ever logs such strings, never raw error objects.

To send failures elsewhere, pass your own `onError`. It receives the raw error, so redact
whatever you log there; `summarizeError()` from `@knead-js/core` produces the same summary the
default uses. An `onError` that throws or rejects is caught and logged as
`[knead:schedule] onError failed for job "sync": TypeError: tracker down`.

<<< schedule/options.ts#options title="app.module.ts"

`logger` receives the scheduler's warnings and the default error reports. It needs only `warn()`
and `error()` (the `ScheduleLogger` interface); the default is the application's injected
`LOGGER`, so scheduler messages go wherever the rest of the application logs. Pass a logger only to
send them somewhere else; `ConsoleLogger` from `@knead-js/core` and the other Knead loggers fit.
Every message is a single redacted string, and control characters in job names are escaped
(`\n`), so a job name built at runtime cannot forge log lines. A `RedisLockStore` is built outside
dependency injection, so its plaintext warning goes to a `ConsoleLogger` unless you pass it a
`logger`.

See the [options table](/packages/schedule/#schedulemodule) for every option and default.

## Managing jobs at runtime

Inject `SchedulerRegistry` to list, pause, resume, trigger, add and remove jobs while the
application runs. This service schedules one cron job per tenant:

<<< schedule/tenant-reports.ts#registry title="tenant-reports.ts"

- `list()` and `get(name)` return `JobInfo` snapshots: `name`, `kind` (`'cron'`, `'interval'` or
  `'timeout'`), `state` (`'scheduled'`, `'paused'` or `'stopped'`), `nextRunAt` and `running`.
- `addCron()`, `addInterval()` and `addTimeout()` add a job. Jobs added before bootstrap (for
  example in an `onModuleInit` hook) start with the decorated ones; jobs added later start
  immediately.
- `pause(name)` disarms the job. `resume(name)` re-arms a paused or stopped job from the current
  time, so firings missed while it was paused do not run.
- `trigger(name)` runs the job now, ignoring its lock, and resolves when the run settles. A
  failure goes to `onError`; `trigger()` itself does not reject because of it.
- `remove(name)` disarms and forgets the job and returns whether it existed. Runs in progress
  finish, and shutdown still waits for them.

An unknown name throws `ScheduleJobNotFoundError` (`No scheduled job named "missing".`). Invalid
patterns or durations, an empty name, a duplicate name, and any change after shutdown throw
`ScheduleConfigError`.

## Running a cron job on one instance

By default every process runs every job. With several replicas, a nightly billing job would charge
customers once per replica. Give `forRoot()` a `lockStore` and set `lock` on the cron jobs that
must run once per firing:

<<< schedule/locks.ts#locks title="app.module.ts"

How the lock works:

- Each firing is claimed under the key `<job name>:<scheduled time in epoch ms>`. Every instance
  computes the same key for the same firing, so the first instance to claim it runs the job and
  the others skip that firing.
- Locks are never released. They expire after the TTL: `lockTtl` (default 60 seconds) for
  `lock: true`, or the job's own `lock: { ttl }`. The TTL is the window in which the same firing
  cannot run twice, so it must exceed the clock skew and timer lateness between your instances. It
  does not need to cover how long the job runs.
- The lock fails closed. If the store throws or times out, the firing is skipped on that instance
  and the error goes to `onError`. A store outage can cause a missed run, never a double run.
- `trigger()` ignores the lock.
- Only cron jobs can be locked. Intervals and timeouts are per process: their times differ between
  instances, so there is no shared firing to claim.
- A job with `lock` and no `lockStore` fails at bootstrap with
  `Job "charge-renewals" uses lock, but ScheduleModule.forRoot() has no lockStore.`

The package has two stores:

- `RedisLockStore` shares locks between every instance connected to the same Redis or Valkey. It
  sends one `SET <prefix><key> 1 NX PX <ttl>` per firing.
- `MemoryLockStore` deduplicates only between schedulers in one process. Use it in tests, or in a
  process that runs several applications.

### Securing the Redis connection

The lock key carries no secrets, but the connection carries your Redis credentials. Use a
`rediss://` (TLS) URL and a least-privilege ACL user that can only `SET` keys under the prefix:

```text
ACL SETUSER scheduler on >long-random-password resetkeys ~knead:schedule:* -@all +set
```

With a plaintext `redis://` or `valkey://` URL to a host that is not loopback, `RedisLockStore`
logs a warning (without the credentials):

```text
[knead:schedule] RedisLockStore connects to cache.internal:6379 over plaintext redis://, so credentials cross the network unencrypted. Use rediss:// (TLS) with an ACL user.
```

Pass `requireTls: true` to throw `ScheduleConfigError` instead, as the example does. The check
applies to `url`, or to `REDIS_URL` and then `VALKEY_URL` when you give neither `url` nor `client`.
A `client` you construct yourself skips the check, so configure TLS on it yourself.

If Redis does not answer within `commandTimeout` (default 250 ms), that firing is skipped and the
error goes to `onError`. A `SET` that times out but that Redis applied anyway leaves the key set,
so every instance skips that firing. `RedisLockStore` turns off the offline queue on the client it
creates, so a timed-out command is never sent later. If you pass your own `client`, create it with
`enableOfflineQueue: false` too.

### Closing the store

The scheduler never closes a lock store. Close it yourself when the application shuts down, in an
`onModuleDestroy` hook as in the example above. `close()` closes a client the store created and
leaves a `client` you passed open.

## Shutdown

When the application closes, the registry's `beforeApplicationShutdown` hook:

1. stops every timer, so no new run starts;
2. aborts the `signal` of every job context;
3. waits up to `shutdownTimeout` (default 10 seconds) for runs in progress.

If runs are still going when the timeout passes, it logs
`[knead:schedule] Shutdown timed out after 10000ms with jobs still running: "slow".` and lets
shutdown continue. A locked firing whose lock was still being acquired does not start. After
shutdown every job reports state `stopped`, and changes throw
`ScheduleConfigError` (`The scheduler has shut down.`).

Knead runs every `beforeApplicationShutdown` hook before any `onModuleDestroy` hook. Close the
connections your jobs use (database clients, the lock store) in `onModuleDestroy`, and jobs finish
before those connections close. See [lifecycle](/guide/lifecycle/) for the full order, and call
`app.enableShutdownHooks()` so that SIGTERM and SIGINT close the application gracefully.

## Turning jobs off

`enabled: false` registers every job paused, so nothing runs on its own. `trigger()` still runs
jobs, and `resume()` arms them individually. Use it on replicas that should only serve HTTP (the
`RUN_JOBS` variable in the [errors example](#errors)), or in tests.

## Testing jobs

In a test, register the jobs paused and run them with `trigger()`, which resolves when the run has
settled. Nothing depends on real time:

<<< schedule/report-jobs.test.ts#test title="report.jobs.test.ts"

Override the job's dependencies with `overrideProvider()` as for any other provider; see
[testing](/guide/testing/).
