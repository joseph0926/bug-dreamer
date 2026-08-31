import { defineScenario } from '@bug-dreamer/scenario';
import { shouldPruneSnapshot, validatePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'snapshot aged exactly to the ttl is retained and one millisecond past it is pruned',
  oracle: {
    basis: 'documentation',
    ref: 'packages/prepaint/src/policy.ts shouldPruneSnapshot: prunes only when now - timestamp is strictly greater than policy.ttlMs',
  },
  inputs: { ttlMs: 1000, now: 1000000, route: '/home' },
  expected:
    'With ttlMs 1000, a snapshot whose age is exactly 1000ms is kept while a snapshot aged 1001ms is pruned.',
  act: async () => {
    const policy = validatePrepaintPolicy({ routes: ['/home'], ttlMs: 1000 });
    const now = 1000000;
    const atTtl = {
      route: '/home',
      body: '<div>cached</div>',
      timestamp: now - 1000,
      styles: [],
    };
    const pastTtl = { ...atTtl, timestamp: now - 1001 };

    return {
      prunedAtExactTtl: shouldPruneSnapshot(atTtl, policy, now),
      prunedPastTtl: shouldPruneSnapshot(pastTtl, policy, now),
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      prunedAtExactTtl: false,
      prunedPastTtl: true,
    });
  },
});
