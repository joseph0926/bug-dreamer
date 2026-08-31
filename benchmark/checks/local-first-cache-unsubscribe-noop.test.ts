import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'stops notifying an unsubscribed cache consumer',
  oracle: {
    basis: 'public-type',
    ref: 'packages/local-first CacheManager.subscribe returns an unsubscribe for that callback',
  },
  inputs: {
    subscribedThenUnsubscribed: true,
  },
  expected: 'An unsubscribed callback receives no further updates and leaves the subscriber set.',
  act: async () => {
    const manager = new CacheManager<string>(1000);
    let calls = 0;
    const unsubscribe = manager.subscribe(() => {
      calls += 1;
    });
    unsubscribe();
    manager.updateWithData('value', Date.now());
    return { subscribers: manager.getSubscriberCount(), calls };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({ subscribers: 0, calls: 0 });
  },
});
