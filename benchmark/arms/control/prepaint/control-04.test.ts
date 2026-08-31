import { defineScenario } from '@bug-dreamer/scenario';
import { getSnapshotPayloadBytes, shouldPruneSnapshot, validatePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'multibyte snapshot exactly at the byte budget is kept and is pruned when the budget shrinks by one byte',
  oracle: {
    basis: 'documentation',
    ref: 'packages/prepaint/src/policy.ts shouldPruneSnapshot uses getSnapshotPayloadBytes with a strict greater-than comparison against maxSnapshotBytes',
  },
  inputs: { route: '/home', body: '한글-payload', ttlMs: 60000, now: 1000, timestamp: 500 },
  expected:
    'A snapshot whose UTF-8 payload size equals maxSnapshotBytes is retained, and reducing maxSnapshotBytes by one byte makes the same snapshot prunable.',
  act: async () => {
    const snapshot = {
      route: '/home',
      body: '한글-payload',
      timestamp: 500,
      styles: [],
    };
    const exactBytes = getSnapshotPayloadBytes(snapshot);
    const keepPolicy = validatePrepaintPolicy({
      routes: ['/home'],
      ttlMs: 60000,
      maxSnapshotBytes: exactBytes,
    });
    const prunePolicy = validatePrepaintPolicy({
      routes: ['/home'],
      ttlMs: 60000,
      maxSnapshotBytes: exactBytes - 1,
    });

    return {
      bytesPositive: exactBytes > 0,
      prunedAtExactBudget: shouldPruneSnapshot(snapshot, keepPolicy, 1000),
      prunedOneByteUnder: shouldPruneSnapshot(snapshot, prunePolicy, 1000),
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      bytesPositive: true,
      prunedAtExactBudget: false,
      prunedOneByteUnder: true,
    });
  },
});
