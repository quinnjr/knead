# @knead-js/schedule

Cron, interval and timeout jobs for Knead. Decorate methods of ordinary providers; `ScheduleModule.forRoot()` finds them in every module when the application bootstraps, starts their timers, and stops them at shutdown.

```ts
import { inject, Module } from '@knead-js/core';
import { Cron, Interval, type JobContext, RedisLockStore, ScheduleModule, Timeout } from '@knead-js/schedule';

class ReportJobs {
  readonly reports = inject(ReportService);

  @Cron('0 3 * * *', { name: 'nightly-report', timezone: 'America/New_York', lock: true })
  async nightly({ signal, scheduledAt }: JobContext) {
    await this.reports.build({ for: scheduledAt, signal });
  }

  @Interval('30s') // name: 'ReportJobs.heartbeat'
  heartbeat() {}

  @Timeout('5s', { name: 'warmup' })
  warmup() {}
}

@Module({
  imports: [ScheduleModule.forRoot({ lockStore: new RedisLockStore({ url: process.env.REDIS_URL }) })],
  providers: [ReportService, ReportJobs],
})
class AppModule {}
```

Jobs live on class providers of any imported module (a provider no module lists is never instantiated, so its jobs never run; `SchedulerRegistry.list()` shows what was registered). A class provided by several modules registers its jobs once. Job names default to `ClassName.methodName` and must be unique.

## Schedules

- `@Cron(pattern, { name?, timezone?, lock? })`: [croner](https://github.com/hexagon/croner) patterns with 5 fields, or 6 with seconds first (an optional 7th is the year), and `@daily`-style macros. `timezone` is an IANA name; the default is the process timezone. Patterns and timezones are validated when the decorator runs, so a typo fails at import, not at 3am.
- `@Interval(every, { name? })`: first run one period after start, then every period.
- `@Timeout(after, { name? })`: runs once, then removes itself.

Durations are milliseconds or strings such as `500ms`, `30s`, `10m`, `1h`, `1d` (at most `365d`).

Runs are timed from the schedule, not from when the previous run finished, so slow jobs do not drift. **Runs may overlap**: a tick starts a new run even if the previous one is still going. Guard against that in the job if it matters. When the process was suspended or the event loop blocked past several ticks, the job runs once and continues from now; missed firings are not caught up.

A handler receives a `JobContext`: `{ name, signal, scheduledAt, trigger }`. `signal` aborts when the application starts shutting down; `trigger` is `'schedule'` or `'manual'`. Handlers are plain method calls, so `inject()` belongs in field initializers, not in the handler.

## Errors

A failing run (a throw or a rejection) goes to `onError(error, ctx)` (default: `console.error`) and never stops the job.

## Running a cron job on one instance

By default every process runs every job. With several replicas, give `forRoot()` a `lockStore` and set `lock: true` (or `lock: { ttl }`) on the cron jobs that must run once per firing. Each firing is claimed under `<job name>:<scheduled time>`, a key every instance computes identically, so the first instance to claim it runs the job and the others skip that firing.

Locks are never released; they expire after the TTL (`lockTtl`, default 60s). The TTL is the window in which the same firing cannot run twice, so it must exceed the clock skew and timer lateness between instances. It does not need to cover how long the job runs. If the lock store fails (Redis down, or slower than `commandTimeout`), the firing is skipped and the error goes to `onError`, so an outage never causes a double run. `trigger()` ignores locks. Intervals and timeouts are per process and cannot be locked.

- `MemoryLockStore` deduplicates within one process.
- `RedisLockStore({ url?, client?, prefix = 'knead:schedule:', commandTimeout = 250, requireTls?, logger? })` runs `SET key 1 NX PX ttl`. Use `rediss://` (TLS) and a least-privilege ACL user, for example `ACL SETUSER scheduler on >secret resetkeys ~knead:schedule:* -@all +set`. A plaintext `redis://` or `valkey://` URL to a non-loopback host logs a warning, and throws with `requireTls: true`. A caller-supplied `client` bypasses that check and is not closed by `close()`. The scheduler never closes a lock store; close it yourself when the app shuts down.

## Runtime control

Inject `SchedulerRegistry`:

```ts
registry.list();                     // [{ name, kind, state, nextRunAt, running }]
registry.addCron('cleanup', '*/5 * * * *', async (ctx) => {}, { timezone: 'UTC', lock: true });
registry.addInterval('poll', '10s', () => {});
registry.addTimeout('once', 1_000, () => {});
registry.pause('poll');              // resume() re-arms from now
await registry.trigger('cleanup');   // runs now, without the lock; resolves when it settles
registry.remove('poll');
```

Jobs added before bootstrap start with the decorated ones; jobs added later start immediately. Unknown names throw `ScheduleJobNotFoundError`; invalid jobs, duplicate names and changes after shutdown throw `ScheduleConfigError`.

## Options

| Option | Default | |
|---|---|---|
| `lockStore` | none | Required by any job with `lock` (bootstrap fails without it) |
| `lockTtl` | `60s` | TTL for `lock: true` |
| `onError` | `console.error` | Receives every failed run and lock store error |
| `shutdownTimeout` | `10s` | How long shutdown waits for runs in progress before logging their names and moving on |
| `enabled` | `true` | `false` registers every job paused (for example on web-only replicas or in tests); `trigger()` still works |

## Shutdown

In `beforeApplicationShutdown` the scheduler stops every timer, aborts `ctx.signal` and waits up to `shutdownTimeout` for runs in progress. Knead runs every `beforeApplicationShutdown` hook before any `onModuleDestroy`, so close connections that jobs use in `onModuleDestroy`, and jobs finish before those connections close.
