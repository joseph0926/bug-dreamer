import { defineScenario } from '@bug-dreamer/scenario';
import {
  getSnapshotPayloadBytes,
  normalizePrepaintPolicy,
  shouldPruneSnapshot,
} from '@target/policy';

defineScenario({
  id: 'payload byte accounting uses utf-8 length and the byte budget boundary is inclusive',
  oracle: {
    basis: 'declared-invariant',
    ref: 'policy.ts getSnapshotPayloadBytes(): utf-8 byte length of JSON {body, styles}; shouldPruneSnapshot prunes only payloads exceeding maxSnapshotBytes',
  },
  inputs: {
    snapshot: { route: '/home', body: 'one 3-byte Hangul character', styles: [] },
    expectedBytes: 26,
    policies: 'maxSnapshotBytes 26 (exact fit) and 25 (one byte short)',
  },
  expected:
    'The multi-byte body serializes to 26 utf-8 bytes, a 26-byte budget keeps the snapshot and a 25-byte budget prunes it.',
  act: async () => {
    const snapshot = { route: '/home', body: '한', timestamp: 1700000000000, styles: [] };
    const bytes = getSnapshotPayloadBytes(snapshot);
    const keepPolicy = normalizePrepaintPolicy({
      routes: ['/home'],
      ttlMs: 60000,
      maxSnapshotBytes: 26,
      includeStyles: true,
    });
    const prunePolicy = normalizePrepaintPolicy({
      routes: ['/home'],
      ttlMs: 60000,
      maxSnapshotBytes: 25,
      includeStyles: true,
    });
    const now = 1700000000500;
    return {
      bytes,
      keptAtLimit: shouldPruneSnapshot(snapshot, keepPolicy, now),
      prunedOverLimit: shouldPruneSnapshot(snapshot, prunePolicy, now),
    };
  },
  assert: (actual, expect) => {
    expect(actual.bytes).toBe(26);
    expect(actual.keptAtLimit).toBe(false);
    expect(actual.prunedOverLimit).toBe(true);
  },
});
