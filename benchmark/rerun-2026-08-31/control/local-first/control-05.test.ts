import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'ttl zero is always stale and ttl Infinity never expires',
  oracle: {
    basis: 'documentation',
    ref: 'packages/local-first/README.md ttl option: "Set to 0 for always-stale behavior"; src/types.ts ModelOptions.ttl: "Infinity is allowed for never expires"',
  },
  inputs: {
    ttlZero: 'CacheManager(0) updated with data at the current instant',
    ttlInfinity: 'CacheManager(Infinity) updated with data 10 days old',
  },
  expected:
    'Freshly written data is immediately stale when ttl is 0, and ten-day-old data is not stale when ttl is Infinity',
  act: async () => {
    const zeroTtl = new CacheManager<number>(0);
    zeroTtl.updateWithData(1, Date.now());
    const foreverTtl = new CacheManager<number>(Infinity);
    foreverTtl.updateWithData(1, Date.now() - 864000000);
    return {
      zeroStale: zeroTtl.getCachedHistory().isStale,
      foreverStale: foreverTtl.getCachedHistory().isStale,
    };
  },
  assert: (actual, expect) => {
    expect(actual.zeroStale).toBe(true);
    expect(actual.foreverStale).toBe(false);
  },
});
