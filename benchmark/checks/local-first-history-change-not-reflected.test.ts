import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'reflects history-only changes in the combined snapshot',
  oracle: {
    basis: 'public-type',
    ref: 'packages/local-first CombinedSnapshot.history is the current ModelHistory',
  },
  inputs: {
    historyOnlyUpdate: true,
    isConflicted: true,
  },
  expected: 'After setHistory, the combined snapshot carries the new history.',
  act: async () => {
    const manager = new CacheManager<string>(1000);
    manager.setHistory({ updatedAt: 5, age: 1, isStale: false, isConflicted: true });
    return manager.getCombinedSnapshot().history.isConflicted;
  },
  assert: (actual, expect) => {
    expect(actual).toBe(true);
  },
});
