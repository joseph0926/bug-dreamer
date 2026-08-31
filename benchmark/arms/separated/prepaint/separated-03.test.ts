import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, shouldPruneSnapshot } from '@target/policy';

defineScenario({
  id: 'a snapshot exactly at the TTL boundary is kept and only strictly older records are pruned',
  oracle: {
    basis: 'existing-test',
    ref: 'INV-PP-08 — test "prunes disallowed, expired, oversized, and style-bearing records" in packages/prepaint/tests/policy.test.ts:54-71; code contract packages/prepaint/src/policy.ts:142',
  },
  inputs: { ttlMs: 1000, agesTested: [0, 500, 1000, 1001] },
  expected:
    'Pruning by age requires now - timestamp strictly greater than ttlMs, so records aged 0, 500, and exactly 1000 are kept while a record aged 1001 is pruned.',
  act: async () => {
    const policy = normalizePrepaintPolicy({ routes: ['/page'], ttlMs: 1000 });
    const now = 1700000000000;
    const record = (age: number) => ({
      route: '/page',
      body: '<div>ok</div>',
      timestamp: now - age,
      styles: [],
    });
    return {
      zeroAge: shouldPruneSnapshot(record(0), policy, now),
      fresh: shouldPruneSnapshot(record(500), policy, now),
      exactlyAtTtl: shouldPruneSnapshot(record(1000), policy, now),
      onePastTtl: shouldPruneSnapshot(record(1001), policy, now),
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      zeroAge: false,
      fresh: false,
      exactlyAtTtl: false,
      onePastTtl: true,
    });
  },
});
