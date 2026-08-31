import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'TTL 0 marks freshly written data stale and TTL Infinity keeps very old data fresh',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-LF-10 — separated invariant catalog, sourced from lf/tests/model-ttl-optional.test.ts "should handle 0 TTL (always stale)" and "should handle Infinity TTL (never expires)"',
  },
  inputs: {
    zeroTtl: 'CacheManager(0) with updateWithData at updatedAt = Date.now()',
    infinityTtl: 'CacheManager(Infinity) with updateWithData at updatedAt = Date.now() - 1e9',
  },
  expected:
    'With TTL 0 the history reports isStale true even for brand-new data; with TTL Infinity the history reports isStale false even for data a billion milliseconds old.',
  act: async () => {
    const zeroTtlCache = new CacheManager<string>(0);
    zeroTtlCache.updateWithData('fresh', Date.now());
    const zeroTtlHistory = zeroTtlCache.getCachedHistory();
    const infinityCache = new CacheManager<string>(Infinity);
    const oldUpdatedAt = Date.now() - 1_000_000_000;
    infinityCache.updateWithData('ancient', oldUpdatedAt);
    const infinityHistory = infinityCache.getCachedHistory();
    return {
      zeroTtlStale: zeroTtlHistory.isStale,
      zeroTtlUpdatedAtSet: zeroTtlHistory.updatedAt > 0,
      infinityStale: infinityHistory.isStale,
      infinityAgeAtLeast: infinityHistory.age >= 1_000_000_000,
    };
  },
  assert: (actual, expect) => {
    expect(actual.zeroTtlStale).toBe(true);
    expect(actual.zeroTtlUpdatedAtSet).toBe(true);
    expect(actual.infinityStale).toBe(false);
    expect(actual.infinityAgeAtLeast).toBe(true);
  },
});
