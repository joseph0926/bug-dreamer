import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'marks data older than the ttl as stale',
  oracle: {
    basis: 'public-type',
    ref: 'packages/local-first ModelHistory.isStale means the data age reached the model ttl',
  },
  inputs: {
    ttlMs: 1000,
    dataAgeMs: 10000,
  },
  expected: 'Data updated longer ago than the ttl reports isStale true.',
  act: async () => {
    const manager = new CacheManager<string>(1000);
    manager.updateWithData('value', Date.now() - 10_000);
    return manager.getCachedHistory().isStale;
  },
  assert: (actual, expect) => {
    expect(actual).toBe(true);
  },
});
