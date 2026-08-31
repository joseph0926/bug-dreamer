import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, validatePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'policy resolves documented defaults and rejects non-absolute or non-string routes',
  oracle: {
    basis: 'documentation',
    ref: 'packages/prepaint/README.md configuration: "routes: Exact pathnames", "ttlMs?: number // Default: 7 days", "maxSnapshotBytes?: number // Default: 1 MiB", "includeStyles?: boolean // Default: true"',
  },
  inputs: {
    minimal: { routes: ['/dashboard'] },
    relativeRoute: { routes: ['dashboard'] },
    nonStringRoute: { routes: ['/ok', 42] },
  },
  expected:
    'A minimal policy resolves with ttlMs 604800000, maxSnapshotBytes 1048576, includeStyles true, while relative or non-string routes make validate throw and normalize return null',
  act: async () => {
    const resolved = normalizePrepaintPolicy({ routes: ['/dashboard'] });
    let relativeError = 'no-throw';
    try {
      validatePrepaintPolicy({ routes: ['dashboard'] });
    } catch (error) {
      relativeError = (error as Error).message;
    }
    let nonStringError = 'no-throw';
    try {
      validatePrepaintPolicy({ routes: ['/ok', 42] });
    } catch (error) {
      nonStringError = (error as Error).message;
    }
    return {
      resolved,
      relativeError,
      nonStringError,
      relativeNormalized: normalizePrepaintPolicy({ routes: ['dashboard'] }),
    };
  },
  assert: (actual, expect) => {
    expect(actual.resolved).toEqual({
      routes: ['/dashboard'],
      ttlMs: 604800000,
      maxSnapshotBytes: 1048576,
      includeStyles: true,
    });
    expect(actual.relativeError).toContain('Invalid prepaint policy');
    expect(actual.nonStringError).toContain('Invalid prepaint policy');
    expect(actual.relativeNormalized).toBeNull();
  },
});
