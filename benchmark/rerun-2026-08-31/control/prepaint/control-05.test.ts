import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, shouldPruneSnapshot } from '@target/policy';

defineScenario({
  id: 'includeStyles false prunes styled snapshots but keeps style-free ones',
  oracle: {
    basis: 'documentation',
    ref: 'packages/prepaint/README.md: "includeStyles?: boolean // Default: true" and "use includeStyles: false when routes can contain user-controlled or sensitive CSS" - styled stored records must not survive under that policy',
  },
  inputs: {
    policy: { routes: ['/dash'], includeStyles: false },
    snapshots: ['styles with one entry', 'styles empty array', 'styles omitted'],
  },
  expected:
    'Under includeStyles false, a snapshot carrying style entries is pruned while snapshots with an empty or omitted styles list are kept',
  act: async () => {
    const now = 1700000000000;
    const policy = normalizePrepaintPolicy({ routes: ['/dash'], includeStyles: false });
    const base = { route: '/dash', body: '<div>ok</div>', timestamp: now - 10 };
    return {
      resolvedIncludeStyles: policy ? policy.includeStyles : null,
      styled: shouldPruneSnapshot({ ...base, styles: ['body{color:red}'] }, policy, now),
      emptyStyles: shouldPruneSnapshot({ ...base, styles: [] }, policy, now),
      noStyles: shouldPruneSnapshot(base, policy, now),
    };
  },
  assert: (actual, expect) => {
    expect(actual.resolvedIncludeStyles).toBe(false);
    expect(actual.styled).toBe(true);
    expect(actual.emptyStyles).toBe(false);
    expect(actual.noStyles).toBe(false);
  },
});
