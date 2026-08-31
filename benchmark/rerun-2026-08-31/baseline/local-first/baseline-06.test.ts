import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'staleness boundaries: fresh data not stale, zero ttl always stale, untouched manager stale with infinite age',
  oracle: {
    basis: 'public-type',
    ref: 'cache-manager.ts ModelHistory semantics: isStale means age reached the ttl; DEFAULT_HISTORY declares age Infinity and isStale true before any data arrives',
  },
  inputs: {
    managers: 'ttl 60000 updated now, ttl 0 (degenerate boundary) updated now, ttl 60000 never updated',
  },
  expected:
    'Data updated just now is not stale under a 60s ttl, a zero ttl marks data stale immediately, and an untouched manager reports stale history with infinite age and null data.',
  act: async () => {
    const fresh = new CacheManager<string>(60000);
    fresh.updateWithData('fresh-data', Date.now());
    const zeroTtl = new CacheManager<string>(0);
    zeroTtl.updateWithData('zero-ttl-data', Date.now());
    const untouched = new CacheManager<string>(60000);
    return {
      freshIsStale: fresh.getCachedHistory().isStale,
      zeroTtlIsStale: zeroTtl.getCachedHistory().isStale,
      initialIsStale: untouched.getCachedHistory().isStale,
      initialAge: untouched.getCachedHistory().age,
      initialData: untouched.getCachedSnapshot(),
    };
  },
  assert: (actual, expect) => {
    expect(actual.freshIsStale).toBe(false);
    expect(actual.zeroTtlIsStale).toBe(true);
    expect(actual.initialIsStale).toBe(true);
    expect(actual.initialAge).toBe(Infinity);
    expect(actual.initialData).toBe(null);
  },
});
