import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'notifies subscribers when the cache enters the error state',
  oracle: {
    basis: 'public-type',
    ref: 'packages/local-first CacheManager.subscribe callbacks fire on cache state changes',
  },
  inputs: {
    transition: 'loading-to-error',
  },
  expected: 'A subscriber is called when updateWithError changes the cache state.',
  act: async () => {
    const manager = new CacheManager<string>(1000);
    let calls = 0;
    manager.subscribe(() => {
      calls += 1;
    });
    manager.updateWithError(new Error('sync failed') as never);
    return { calls, status: manager.getCacheState().status };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({ calls: 1, status: 'error' });
  },
});
