import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'combined snapshot is referentially stable between mutations and replaced after updateWithData',
  oracle: {
    basis: 'declared-invariant',
    ref: 'cache-manager.ts updateSnapshot(): cached snapshot object is reused when nothing changed so external-store consumers can compare by reference',
  },
  inputs: {
    ttl: 60000,
    sequence: 'read snapshot twice while loading, updateWithData({v:1}), read snapshot twice again',
  },
  expected:
    'Repeated reads return the same snapshot object until a mutation happens, and updateWithData produces exactly one new snapshot carrying the data with success status.',
  act: async () => {
    const manager = new CacheManager<{ v: number }>(60000);
    const s1 = manager.getCombinedSnapshot();
    const s2 = manager.getCombinedSnapshot();
    manager.updateWithData({ v: 1 }, Date.now());
    const s3 = manager.getCombinedSnapshot();
    const s4 = manager.getCombinedSnapshot();
    return {
      stableWhileLoading: s1 === s2,
      newAfterUpdate: s3 !== s1,
      stableAfterUpdate: s3 === s4,
      status: s3.status,
      data: s3.data,
      errorNull: s3.error === null,
    };
  },
  assert: (actual, expect) => {
    expect(actual.stableWhileLoading).toBe(true);
    expect(actual.newAfterUpdate).toBe(true);
    expect(actual.stableAfterUpdate).toBe(true);
    expect(actual.status).toBe('success');
    expect(actual.data).toEqual({ v: 1 });
    expect(actual.errorNull).toBe(true);
  },
});
