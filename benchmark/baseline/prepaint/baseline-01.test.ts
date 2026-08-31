import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, shouldPruneSnapshot } from '@target/policy';

defineScenario({
  id: 'snapshot with NaN timestamp is pruned instead of living forever',
  oracle: {
    basis: 'documentation',
    ref: 'packages/prepaint/README.md "TTL: 7 days (auto-expires)" and "stale records are pruned" — a record whose timestamp is NaN can never expire, so it must be treated as invalid and pruned',
  },
  inputs: {
    policy: { routes: ['/dashboard'] },
    snapshot: { route: '/dashboard', body: '<div>cached</div>', timestamp: 'NaN' },
    now: 1700000000000,
  },
  expected:
    'shouldPruneSnapshot returns true for a snapshot whose timestamp is NaN, because such a record would otherwise bypass TTL expiry permanently.',
  act: async () => {
    const policy = normalizePrepaintPolicy({ routes: ['/dashboard'] });
    const pruned = shouldPruneSnapshot(
      { route: '/dashboard', body: '<div>cached</div>', timestamp: Number.NaN },
      policy,
      1700000000000,
    );
    return { pruned };
  },
  assert: (actual, expect) => {
    expect(actual.pruned).toBe(true);
  },
});
