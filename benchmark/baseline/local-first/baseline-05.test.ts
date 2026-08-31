import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'isStale is false when age equals ttl exactly',
  oracle: {
    basis: 'documentation',
    ref: 'packages/local-first/README.md "isStale: boolean - Whether age > ttl" and packages/local-first/src/types.ts ModelHistory.isStale doc comment "age > ttl"',
  },
  inputs: {
    ttlMs: 1000,
    updatedAt: 'frozen now minus exactly 1000ms',
    clock: 'Date.now frozen during the check',
  },
  expected:
    'With age exactly equal to ttl, the documented rule age > ttl is not satisfied, so isStale must be false at the boundary.',
  act: async () => {
    const realNow = Date.now;
    try {
      const frozen = realNow();
      Date.now = () => frozen;
      const ttl = 1000;
      const manager = new CacheManager<string>(ttl);
      manager.updateWithData('value', frozen - ttl);
      const history = manager.getCachedHistory();
      return { age: history.age, ttl, isStale: history.isStale };
    } finally {
      Date.now = realNow;
    }
  },
  assert: (actual, expect) => {
    expect(actual.age).toBe(actual.ttl);
    expect(actual.isStale).toBe(false);
  },
});
