import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'zero ttl marks freshly written data as stale immediately',
  oracle: {
    basis: 'public-type',
    ref: 'packages/local-first/src/types.ts ModelHistory.isStale: data is stale once its age reaches the configured ttl, so ttl 0 means always stale',
  },
  inputs: { ttl: 0, data: 'fresh' },
  expected:
    'With a ttl of 0, data written with the current timestamp is reported stale immediately while still being served as a success snapshot.',
  act: async () => {
    const cache = new CacheManager<string>(0);
    cache.updateWithData('fresh', Date.now());
    const history = cache.getCachedHistory();
    const snapshot = cache.getCombinedSnapshot();

    return {
      isStale: history.isStale,
      isConflicted: history.isConflicted,
      status: snapshot.status,
      data: snapshot.data,
      historyShared: snapshot.history === history,
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      isStale: true,
      isConflicted: false,
      status: 'success',
      data: 'fresh',
      historyShared: true,
    });
  },
});
