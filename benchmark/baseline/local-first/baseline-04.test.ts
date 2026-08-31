import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'combined snapshot history stays in sync after direct updateHistory',
  oracle: {
    basis: 'public-type',
    ref: 'packages/local-first/src/cache-manager.ts CombinedSnapshot.history: ModelHistory — the combined snapshot exposes the model history, so it must match getCachedHistory() after any history update',
  },
  inputs: {
    ttlMs: 60000,
    firstUpdate: 'updateWithData at now-5000',
    secondUpdate: 'updateHistory at now',
  },
  expected:
    'After calling updateHistory with a newer updatedAt, getCombinedSnapshot().history reports the same updatedAt as getCachedHistory() instead of a stale earlier value.',
  act: async () => {
    const manager = new CacheManager<{ count: number }>(60000);
    const firstUpdatedAt = Date.now() - 5000;
    manager.updateWithData({ count: 1 }, firstUpdatedAt);
    const secondUpdatedAt = firstUpdatedAt + 5000;
    manager.updateHistory(secondUpdatedAt);
    return {
      directUpdatedAt: manager.getCachedHistory().updatedAt,
      combinedUpdatedAt: manager.getCombinedSnapshot().history.updatedAt,
      secondUpdatedAt,
    };
  },
  assert: (actual, expect) => {
    expect(actual.directUpdatedAt).toBe(actual.secondUpdatedAt);
    expect(actual.combinedUpdatedAt).toBe(actual.secondUpdatedAt);
  },
});
