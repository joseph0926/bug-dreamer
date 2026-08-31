import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'combined snapshot keeps referential identity across no-op transitions and changes identity on real updates',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/local-first/src/cache-manager.ts updateSnapshot(): the cached snapshot object is reused when data, status, error and history are unchanged',
  },
  inputs: { ttl: 60000, payload: { v: 1 } },
  expected:
    'Calling setLoading twice in a row returns the exact same snapshot object both times, while a subsequent updateWithData produces a new snapshot that holds the stored data by reference.',
  act: async () => {
    const cache = new CacheManager<{ v: number }>(60000);

    cache.setLoading();
    const snapA = cache.getCombinedSnapshot();
    cache.setLoading();
    const snapB = cache.getCombinedSnapshot();

    const payload = { v: 1 };
    cache.updateWithData(payload, Date.now());
    const snapC = cache.getCombinedSnapshot();

    return {
      stableWhenUnchanged: snapA === snapB,
      changedAfterData: snapB !== snapC,
      dataByReference: snapC.data === payload,
      statusAfterData: snapC.status,
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      stableWhenUnchanged: true,
      changedAfterData: true,
      dataByReference: true,
      statusAfterData: 'success',
    });
  },
});
