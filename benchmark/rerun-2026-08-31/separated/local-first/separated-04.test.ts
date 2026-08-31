import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';
import { StorageError } from '@target/errors';

defineScenario({
  id: 'cache state is exclusive: snapshot only in success, error only in error, both null in loading',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-LF-08 — separated invariant catalog, sourced from public types CacheState (lf/src/cache-manager.ts:4-5) and CacheStatus (lf/src/types.ts:82) plus lf/tests/model.test.ts null-read assertions',
  },
  inputs: {
    transitions: [
      'updateWithData("payload", now)',
      'updateWithError(StorageError UNKNOWN)',
      'setLoading()',
    ],
  },
  expected:
    'After data the error read is null; after error the snapshot read is null and the error is returned; after setLoading both reads are null.',
  act: async () => {
    const cache = new CacheManager<string>(60_000);
    cache.updateWithData('payload', Date.now());
    const afterData = {
      status: cache.getCacheState().status,
      snapshot: cache.getCachedSnapshot(),
      error: cache.getCachedError(),
    };
    const storageError = new StorageError('sep04 boom', 'UNKNOWN', true, { operation: 'get' });
    cache.updateWithError(storageError);
    const afterError = {
      status: cache.getCacheState().status,
      snapshot: cache.getCachedSnapshot(),
      errorIsSame: cache.getCachedError() === storageError,
    };
    cache.setLoading();
    const afterLoading = {
      status: cache.getCacheState().status,
      snapshot: cache.getCachedSnapshot(),
      error: cache.getCachedError(),
    };
    return { afterData, afterError, afterLoading };
  },
  assert: (actual, expect) => {
    expect(actual.afterData.status).toBe('success');
    expect(actual.afterData.snapshot).toBe('payload');
    expect(actual.afterData.error).toBe(null);
    expect(actual.afterError.status).toBe('error');
    expect(actual.afterError.snapshot).toBe(null);
    expect(actual.afterError.errorIsSame).toBe(true);
    expect(actual.afterLoading.status).toBe('loading');
    expect(actual.afterLoading.snapshot).toBe(null);
    expect(actual.afterLoading.error).toBe(null);
  },
});
