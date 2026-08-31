import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, shouldPruneSnapshot } from '@target/policy';

defineScenario({
  id: 'prunes snapshots older than their ttl',
  oracle: {
    basis: 'public-type',
    ref: 'packages/prepaint PrepaintPolicy.ttlMs bounds a snapshot age measured from capture time',
  },
  inputs: {
    ttlMs: 1000,
    snapshotAgeMs: 10000,
  },
  expected: 'A snapshot captured longer ago than ttlMs is pruned.',
  act: async () => {
    const policy = normalizePrepaintPolicy({ routes: ['/home'], ttlMs: 1000 });
    const now = 1_000_000;
    return shouldPruneSnapshot(
      { route: '/home', body: '<div>stale</div>', timestamp: now - 10_000 },
      policy,
      now,
    );
  },
  assert: (actual, expect) => {
    expect(actual).toBe(true);
  },
});
