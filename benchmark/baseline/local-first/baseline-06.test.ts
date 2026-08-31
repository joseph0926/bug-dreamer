import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'one throwing subscriber does not block other subscribers or the update',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/local-first/src/cache-manager.ts subscribe/notifySubscribers contract (README "subscribe(callback) - Listen to changes"): a store update must notify every registered subscriber, and a listener error must not break the store write path',
  },
  inputs: {
    subscribers: [{ behavior: 'throws on notify' }, { behavior: 'records notification' }],
    update: 'updateWithData("fresh", now)',
  },
  expected:
    'When the first subscriber throws during notification, the second subscriber is still notified and updateWithData does not propagate the listener error to the caller.',
  act: async () => {
    const manager = new CacheManager<string>(60000);
    let secondNotified = false;
    manager.subscribe(() => {
      throw new Error('listener exploded');
    });
    manager.subscribe(() => {
      secondNotified = true;
    });
    let updateThrew = false;
    try {
      manager.updateWithData('fresh', Date.now());
    } catch {
      updateThrew = true;
    }
    return {
      secondNotified,
      updateThrew,
      cachedData: manager.getCachedSnapshot(),
    };
  },
  assert: (actual, expect) => {
    expect(actual.cachedData).toBe('fresh');
    expect(actual.secondNotified).toBe(true);
    expect(actual.updateThrew).toBe(false);
  },
});
