import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, shouldPruneSnapshot } from '@target/policy';

defineScenario({
  id: 'snapshot pruning gates: allowed fresh snapshot kept, wrong route, expired ttl, missing policy and malformed snapshot pruned',
  oracle: {
    basis: 'declared-invariant',
    ref: 'policy.ts shouldPruneSnapshot(): a snapshot survives only with an active policy, an allowed route, age within ttlMs and a well-formed shape',
  },
  inputs: {
    policy: { routes: ['/home'], ttlMs: 1000, maxSnapshotBytes: 1000000, includeStyles: true },
    now: 1700000000000,
    snapshots: 'fresh allowed, route /admin, aged ttl+1ms, no policy, missing body and timestamp',
  },
  expected:
    'Only the fresh snapshot for an allowed route is kept; disallowed route, expired age, null policy and malformed snapshots are all pruned.',
  act: async () => {
    const policy = normalizePrepaintPolicy({
      routes: ['/home'],
      ttlMs: 1000,
      maxSnapshotBytes: 1000000,
      includeStyles: true,
    });
    const now = 1700000000000;
    const base = { route: '/home', body: '<div>hi</div>', timestamp: now - 10, styles: [] };
    return {
      freshAllowed: shouldPruneSnapshot(base, policy, now),
      disallowedRoute: shouldPruneSnapshot({ ...base, route: '/admin' }, policy, now),
      expired: shouldPruneSnapshot({ ...base, timestamp: now - 1001 }, policy, now),
      noPolicy: shouldPruneSnapshot(base, null, now),
      malformed: shouldPruneSnapshot({ route: '/home' }, policy, now),
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      freshAllowed: false,
      disallowedRoute: true,
      expired: true,
      noPolicy: true,
      malformed: true,
    });
  },
});
