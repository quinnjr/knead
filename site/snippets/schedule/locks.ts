import { Module, type OnModuleDestroy } from '@knead-js/core';
import { Cron, RedisLockStore, ScheduleModule } from '@knead-js/schedule';

// #region locks
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
// #endregion locks
