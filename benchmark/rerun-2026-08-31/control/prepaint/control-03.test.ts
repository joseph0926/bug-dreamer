import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, validatePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'degenerate ttlMs and maxSnapshotBytes values are rejected as invalid policy',
  oracle: {
    basis: 'declared-invariant',
    ref: 'src/policy.ts parsePolicy contract: "ttlMs must be a positive finite number", "maxSnapshotBytes must be a positive safe integer"; validatePrepaintPolicy throws "[FirstTx] Invalid prepaint policy: ..."',
  },
  inputs: {
    ttlValues: [0, -1, 'Infinity', 'NaN'],
    byteValues: [0, 1.5],
    validControl: { routes: ['/a'], ttlMs: 1, maxSnapshotBytes: 1 },
  },
  expected:
    'Zero, negative, infinite, and NaN ttlMs and zero or fractional maxSnapshotBytes all throw from validate and normalize to null, while minimal positive values resolve',
  act: async () => {
    const outcome = (policy: unknown) => {
      try {
        const value = validatePrepaintPolicy(policy);
        return value === null ? 'null' : 'resolved';
      } catch {
        return 'throw';
      }
    };
    return {
      ttlZero: outcome({ routes: ['/a'], ttlMs: 0 }),
      ttlNegative: outcome({ routes: ['/a'], ttlMs: -1 }),
      ttlInfinity: outcome({ routes: ['/a'], ttlMs: Infinity }),
      ttlNaN: outcome({ routes: ['/a'], ttlMs: NaN }),
      bytesZero: outcome({ routes: ['/a'], maxSnapshotBytes: 0 }),
      bytesFraction: outcome({ routes: ['/a'], maxSnapshotBytes: 1.5 }),
      valid: outcome({ routes: ['/a'], ttlMs: 1, maxSnapshotBytes: 1 }),
      normalizedInvalid: normalizePrepaintPolicy({ routes: ['/a'], ttlMs: 0 }),
    };
  },
  assert: (actual, expect) => {
    expect(actual.ttlZero).toBe('throw');
    expect(actual.ttlNegative).toBe('throw');
    expect(actual.ttlInfinity).toBe('throw');
    expect(actual.ttlNaN).toBe('throw');
    expect(actual.bytesZero).toBe('throw');
    expect(actual.bytesFraction).toBe('throw');
    expect(actual.valid).toBe('resolved');
    expect(actual.normalizedInvalid).toBeNull();
  },
});
