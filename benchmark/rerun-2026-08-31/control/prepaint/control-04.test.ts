import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, shouldPruneSnapshot } from '@target/policy';

defineScenario({
  id: 'pruning enforces route ttl and utf8 byte budget over stored records',
  oracle: {
    basis: 'documentation',
    ref: 'packages/prepaint/README.md: "the same policy governs capture, restore, and stored-record pruning", "maxSnapshotBytes ... Default: 1 MiB, UTF-8 JSON payload", "every boot prunes records outside the current policy"',
  },
  inputs: {
    policy: { routes: ['/dash'], ttlMs: 1000, maxSnapshotBytes: 200 },
    oversizedBody: '100 Korean characters (300 UTF-8 bytes, 100 JS characters)',
    now: 1700000000000,
  },
  expected:
    'Fresh small snapshots on an allowed route are kept; wrong-route, expired, malformed, and multi-byte snapshots whose UTF-8 JSON payload exceeds the byte budget are pruned, as is everything when no policy resolves',
  act: async () => {
    const now = 1700000000000;
    const policy = normalizePrepaintPolicy({
      routes: ['/dash'],
      ttlMs: 1000,
      maxSnapshotBytes: 200,
    });
    const fresh = { route: '/dash', body: '<div>ok</div>', timestamp: now - 10, styles: [] };
    const multiByteBody = '한'.repeat(100);
    return {
      fresh: shouldPruneSnapshot(fresh, policy, now),
      wrongRoute: shouldPruneSnapshot({ ...fresh, route: '/other' }, policy, now),
      expired: shouldPruneSnapshot({ ...fresh, timestamp: now - 2001 }, policy, now),
      oversizedUtf8: shouldPruneSnapshot(
        { route: '/dash', body: multiByteBody, timestamp: now - 10, styles: [] },
        policy,
        now,
      ),
      missingBody: shouldPruneSnapshot({ route: '/dash', timestamp: now }, policy, now),
      withoutPolicy: shouldPruneSnapshot(fresh, null, now),
    };
  },
  assert: (actual, expect) => {
    expect(actual.fresh).toBe(false);
    expect(actual.wrongRoute).toBe(true);
    expect(actual.expired).toBe(true);
    expect(actual.oversizedUtf8).toBe(true);
    expect(actual.missingBody).toBe(true);
    expect(actual.withoutPolicy).toBe(true);
  },
});
