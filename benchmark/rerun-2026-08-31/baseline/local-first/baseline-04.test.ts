import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'setHistory changes the combined snapshot and must notify subscribers',
  oracle: {
    basis: 'declared-invariant',
    ref: 'cache-manager.ts subscribe/notifySubscribers external-store contract: every mutation that produces a new combined snapshot notifies subscribers, as updateWithData, updateWithError and setLoading do',
  },
  inputs: {
    ttl: 60000,
    mutation: 'setHistory with isConflicted true while one subscriber is registered',
  },
  expected:
    'After setHistory the combined snapshot is a new object exposing the conflicted history, and the registered subscriber has been notified exactly once.',
  act: async () => {
    const manager = new CacheManager<{ id: number }>(60000);
    let notifications = 0;
    manager.subscribe(() => {
      notifications += 1;
    });
    const before = manager.getCombinedSnapshot();
    manager.setHistory({
      updatedAt: 1700000000000,
      age: 5,
      isStale: false,
      isConflicted: true,
    });
    const after = manager.getCombinedSnapshot();
    return {
      snapshotChanged: before !== after,
      conflictVisible: after.history.isConflicted,
      notifications,
    };
  },
  assert: (actual, expect) => {
    expect(actual.snapshotChanged).toBe(true);
    expect(actual.conflictVisible).toBe(true);
    expect(actual.notifications).toBe(1);
  },
});
