import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, validatePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'invalid limits make validatePrepaintPolicy throw while normalizePrepaintPolicy returns null for the same inputs',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-PP-05 — separated invariant catalog, sourced from pp/tests/policy.test.ts "rejects invalid limits and relative routes" and code contract pp/src/policy.ts:46-57,75-85',
  },
  inputs: {
    zeroTtl: { routes: ['/a'], ttlMs: 0 },
    unsafeBytes: { routes: ['/a'], maxSnapshotBytes: Number.MAX_VALUE },
  },
  expected:
    'validatePrepaintPolicy throws for ttlMs 0 and for maxSnapshotBytes Number.MAX_VALUE; normalizePrepaintPolicy returns null for both without throwing.',
  act: async () => {
    const zeroTtl = { routes: ['/a'], ttlMs: 0 };
    const unsafeBytes = { routes: ['/a'], maxSnapshotBytes: Number.MAX_VALUE };
    let validateZeroTtl = 'no-throw';
    try {
      validatePrepaintPolicy(zeroTtl);
    } catch {
      validateZeroTtl = 'threw';
    }
    let validateUnsafeBytes = 'no-throw';
    try {
      validatePrepaintPolicy(unsafeBytes);
    } catch {
      validateUnsafeBytes = 'threw';
    }
    return {
      validateZeroTtl,
      validateUnsafeBytes,
      normalizeZeroTtl: normalizePrepaintPolicy(zeroTtl),
      normalizeUnsafeBytes: normalizePrepaintPolicy(unsafeBytes),
    };
  },
  assert: (actual, expect) => {
    expect(actual.validateZeroTtl).toBe('threw');
    expect(actual.validateUnsafeBytes).toBe('threw');
    expect(actual.normalizeZeroTtl).toBe(null);
    expect(actual.normalizeUnsafeBytes).toBe(null);
  },
});
