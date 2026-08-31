import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, shouldPruneSnapshot } from '@target/policy';

defineScenario({
  id: 'snapshot with far-future timestamp is pruned as invalid',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/prepaint/src/types.ts Snapshot.timestamp is the capture time and packages/prepaint/src/policy.ts shouldPruneSnapshot validates record shape — a capture time later than now is impossible, so the record is corrupt and must be pruned',
  },
  inputs: {
    policy: { routes: ['/dashboard'] },
    snapshot: {
      route: '/dashboard',
      body: '<div>cached</div>',
      timestamp: 'now + one year (clock skew or corrupted record)',
    },
    now: 1700000000000,
  },
  expected:
    'A snapshot whose timestamp lies a year in the future is invalid and shouldPruneSnapshot returns true rather than keeping the record beyond any TTL horizon.',
  act: async () => {
    const now = 1700000000000;
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    const policy = normalizePrepaintPolicy({ routes: ['/dashboard'] });
    const pruned = shouldPruneSnapshot(
      { route: '/dashboard', body: '<div>cached</div>', timestamp: now + oneYearMs },
      policy,
      now,
    );
    return { pruned };
  },
  assert: (actual, expect) => {
    expect(actual.pruned).toBe(true);
  },
});
