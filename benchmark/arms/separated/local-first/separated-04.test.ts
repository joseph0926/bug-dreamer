import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'data whose age exactly equals the TTL is not yet stale under the documented strict age > ttl rule',
  oracle: {
    basis: 'documentation',
    ref: 'INV-LF-10 — packages/local-first/src/types.ts:76 ("age > ttl") and packages/local-first/README.md:222 ("Whether `age > ttl`") (conflicts with packages/local-first/src/cache-manager.ts:84 `isStale: age >= this.ttl`)',
  },
  inputs: { ttlMs: 5000, agesTested: [4999, 5000, 5001] },
  expected:
    'Per the documented rule isStale is age > ttl, so age 4999 and age exactly 5000 report isStale false and only age 5001 reports isStale true for a 5000ms TTL.',
  act: async () => {
    const realNow = Date.now;
    try {
      const fixedNow = 1700000000000;
      Date.now = () => fixedNow;
      const ttl = 5000;
      const manager = new CacheManager<string>(ttl);
      manager.updateWithData('fresh', fixedNow - (ttl - 1));
      const underTtl = manager.getCachedHistory().isStale;
      manager.updateWithData('boundary', fixedNow - ttl);
      const exactlyAtTtl = manager.getCachedHistory().isStale;
      manager.updateWithData('old', fixedNow - (ttl + 1));
      const overTtl = manager.getCachedHistory().isStale;
      return { underTtl, exactlyAtTtl, overTtl };
    } finally {
      Date.now = realNow;
    }
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      underTtl: false,
      exactlyAtTtl: false,
      overTtl: true,
    });
  },
});
