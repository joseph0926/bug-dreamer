import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, shouldPruneSnapshot } from '@target/policy';

defineScenario({
  id: 'prunes snapshots whose encoded payload exceeds the byte limit',
  oracle: {
    basis: 'public-type',
    ref: 'packages/prepaint PrepaintPolicy.maxSnapshotBytes bounds the encoded payload size in bytes',
  },
  inputs: {
    maxSnapshotBytes: 100,
    bodyCharacters: 50,
    bytesPerCharacter: 3,
  },
  expected: 'A multibyte snapshot larger than maxSnapshotBytes is pruned.',
  act: async () => {
    const policy = normalizePrepaintPolicy({ routes: ['/home'], maxSnapshotBytes: 100 });
    const now = 1_000_000;
    return shouldPruneSnapshot(
      { route: '/home', body: '한'.repeat(50), timestamp: now },
      policy,
      now,
    );
  },
  assert: (actual, expect) => {
    expect(actual).toBe(true);
  },
});
