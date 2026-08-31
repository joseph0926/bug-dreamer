import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, shouldPruneSnapshot } from '@target/policy';

defineScenario({
  id: 'a snapshot exactly at the TTL boundary is kept and one millisecond past it is pruned',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-PP-08 — separated invariant catalog, sourced from pp/tests/policy.test.ts "prunes disallowed, expired, oversized, and style-bearing records" (lines 69-71) and code contract pp/src/policy.ts:142',
  },
  inputs: {
    policy: { routes: ['/a'], ttlMs: 1000 },
    record: { route: '/a', body: 'x', timestamp: 5000 },
    nowValues: [5500, 6000, 6001],
  },
  expected:
    'With ttlMs 1000 and timestamp 5000, the record is kept at now 5500 (age 500) and at now 6000 (age exactly 1000), and pruned at now 6001 (age 1001).',
  act: async () => {
    const policy = normalizePrepaintPolicy({ routes: ['/a'], ttlMs: 1000 });
    const record = { route: '/a', body: 'x', timestamp: 5000 };
    return {
      policyResolved: policy !== null,
      freshKept: shouldPruneSnapshot(record, policy, 5500),
      boundaryKept: shouldPruneSnapshot(record, policy, 6000),
      expiredPruned: shouldPruneSnapshot(record, policy, 6001),
    };
  },
  assert: (actual, expect) => {
    expect(actual.policyResolved).toBe(true);
    expect(actual.freshKept).toBe(false);
    expect(actual.boundaryKept).toBe(false);
    expect(actual.expiredPruned).toBe(true);
  },
});
