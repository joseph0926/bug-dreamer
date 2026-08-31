import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, shouldPruneSnapshot } from '@target/policy';

defineScenario({
  id: 'ttlMs is a configurable policy field honored by resolution and pruning, not a fixed 7-day TTL',
  oracle: {
    basis: 'documentation',
    ref: 'INV-PP-14 — packages/prepaint/README.md:162 ("ttlMs?: number // Default: 7 days", configurable policy field) (conflicts with packages/prepaint/README.md:382 limitations row "Fixed 7-day TTL | Override in source (config planned)")',
  },
  inputs: { customTtlMs: 2000, sevenDaysMs: 604800000 },
  expected:
    'A policy configured with ttlMs 2000 resolves to ttlMs 2000 and pruning uses that custom TTL, pruning a record far younger than 7 days once it is older than 2000ms.',
  act: async () => {
    const policy = normalizePrepaintPolicy({ routes: ['/deals'], ttlMs: 2000 });
    const now = 1700000000000;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const record = (age: number) => ({
      route: '/deals',
      body: '<p>deal</p>',
      timestamp: now - age,
      styles: [],
    });
    return {
      resolvedTtlMs: policy?.ttlMs ?? null,
      keptWithinCustomTtl: shouldPruneSnapshot(record(1500), policy, now),
      prunedPastCustomTtl: shouldPruneSnapshot(record(2001), policy, now),
      prunedLongBeforeSevenDays: shouldPruneSnapshot(record(sevenDays / 2), policy, now),
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      resolvedTtlMs: 2000,
      keptWithinCustomTtl: false,
      prunedPastCustomTtl: true,
      prunedLongBeforeSevenDays: true,
    });
  },
});
