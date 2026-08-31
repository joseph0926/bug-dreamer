import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';
import { StorageError } from '@target/errors';

defineScenario({
  id: 'every state transition synchronously notifies all subscribers and unsubscribing stops future notifications',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-LF-13 — separated invariant catalog, sourced from explicit code contract lf/src/cache-manager.ts:60-77,94-107 and subscriber assertions in lf/tests/broadcast.test.ts',
  },
  inputs: {
    subscribers: ['first', 'second'],
    transitions: ['updateWithData', 'updateWithError', 'setLoading after unsubscribing first'],
  },
  expected:
    'updateWithData and updateWithError each synchronously bump both subscriber counters in the same tick; after unsubscribing the first subscriber, setLoading notifies only the second.',
  act: async () => {
    const cache = new CacheManager<number>(60_000);
    let firstCalls = 0;
    let secondCalls = 0;
    const unsubscribeFirst = cache.subscribe(() => {
      firstCalls += 1;
    });
    cache.subscribe(() => {
      secondCalls += 1;
    });
    cache.updateWithData(1, Date.now());
    const afterData = { firstCalls, secondCalls };
    cache.updateWithError(new StorageError('sep06 boom', 'UNKNOWN', true, { operation: 'set' }));
    const afterError = { firstCalls, secondCalls };
    unsubscribeFirst();
    cache.setLoading();
    const afterLoading = { firstCalls, secondCalls };
    return { afterData, afterError, afterLoading };
  },
  assert: (actual, expect) => {
    expect(actual.afterData).toEqual({ firstCalls: 1, secondCalls: 1 });
    expect(actual.afterError).toEqual({ firstCalls: 2, secondCalls: 2 });
    expect(actual.afterLoading).toEqual({ firstCalls: 2, secondCalls: 3 });
  },
});
