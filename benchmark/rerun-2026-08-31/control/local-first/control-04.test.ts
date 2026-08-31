import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'history at the exact ttl boundary is not yet stale per the age greater than ttl contract',
  oracle: {
    basis: 'public-type',
    ref: 'src/types.ts ModelHistory.isStale doc comment "age > ttl"; packages/local-first/README.md "isStale: boolean - Whether age > ttl"',
  },
  inputs: {
    ttl: 5000,
    updatedAt: 'exactly ttl milliseconds before a frozen Date.now()',
  },
  expected:
    'With age exactly equal to ttl, isStale is false because staleness is defined as age strictly greater than ttl',
  act: async () => {
    const realNow = Date.now;
    try {
      const NOW = 1700000000000;
      Date.now = () => NOW;
      const cache = new CacheManager<number>(5000);
      cache.updateWithData(42, NOW - 5000);
      const history = cache.getCachedHistory();
      return { age: history.age, isStale: history.isStale, updatedAt: history.updatedAt };
    } finally {
      Date.now = realNow;
    }
  },
  assert: (actual, expect) => {
    expect(actual.age).toBe(5000);
    expect(actual.updatedAt).toBe(1699999995000);
    expect(actual.isStale).toBe(false);
  },
});
