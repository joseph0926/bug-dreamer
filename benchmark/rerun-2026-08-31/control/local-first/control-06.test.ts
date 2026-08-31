import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'setHistory changes the combined snapshot and must notify subscribers',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/local-first/README.md: "React integration via useSyncExternalStore" - a store must call its subscribers whenever the snapshot it serves changes, and CacheManager.subscribe is that store subscription',
  },
  inputs: {
    sequence:
      'updateWithData, subscribe a listener, read combined snapshot twice, then setHistory with a new ModelHistory object',
  },
  expected:
    'The combined snapshot is referentially stable between reads, is replaced after setHistory with the new history applied, and the subscriber is notified of that change',
  act: async () => {
    const cache = new CacheManager<string>(60000);
    cache.updateWithData('a', Date.now());
    let notified = 0;
    cache.subscribe(() => {
      notified++;
    });
    const before = cache.getCombinedSnapshot();
    const stableBefore = before === cache.getCombinedSnapshot();
    cache.setHistory({ updatedAt: 123, age: 5, isStale: false, isConflicted: true });
    const after = cache.getCombinedSnapshot();
    return {
      stableBefore,
      snapshotReplaced: after !== before,
      historyUpdatedAt: after.history.updatedAt,
      notified,
    };
  },
  assert: (actual, expect) => {
    expect(actual.stableBefore).toBe(true);
    expect(actual.snapshotReplaced).toBe(true);
    expect(actual.historyUpdatedAt).toBe(123);
    expect(actual.notified).toBeGreaterThanOrEqual(1);
  },
});
