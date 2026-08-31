import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'cache reads track the single active state across a full loading-success-error-loading lifecycle with falsy data 0',
  oracle: {
    basis: 'public-type',
    ref: 'INV-LF-08 — public types CacheState in packages/local-first/src/cache-manager.ts:4-5 and CacheStatus in packages/local-first/src/types.ts:82; tests packages/local-first/tests/model.test.ts:14,407',
  },
  inputs: { ttlMs: 60000, dataValue: 0, transitions: ['initial', 'data', 'error', 'loading'] },
  expected:
    'getCachedSnapshot returns the data (including falsy 0) only in success and null otherwise, getCachedError returns an error only in error and null otherwise, matching exactly one state at a time.',
  act: async () => {
    const manager = new CacheManager<number>(60000);
    const states: Array<{ snapshot: number | null; hasError: boolean; loading: boolean }> = [];
    const record = () => {
      states.push({
        snapshot: manager.getCachedSnapshot(),
        hasError: manager.getCachedError() !== null,
        loading: manager.isLoading(),
      });
    };
    record();
    manager.updateWithData(0, Date.now());
    record();
    manager.updateWithError(new Error('load failed') as never);
    record();
    manager.setLoading();
    record();
    return states;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual([
      { snapshot: null, hasError: false, loading: true },
      { snapshot: 0, hasError: false, loading: false },
      { snapshot: null, hasError: true, loading: false },
      { snapshot: null, hasError: false, loading: true },
    ]);
  },
});
