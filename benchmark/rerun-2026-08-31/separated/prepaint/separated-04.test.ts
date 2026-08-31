import { defineScenario } from '@bug-dreamer/scenario';
import { getSnapshotPayloadBytes } from '@target/policy';

defineScenario({
  id: 'snapshot size is the UTF-8 byte length of the JSON payload so multibyte characters and styles enlarge it',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-PP-06 — separated invariant catalog, sourced from pp/tests/policy.test.ts "measures the UTF-8 payload including stored styles" and pp/README.md maxSnapshotBytes "UTF-8 JSON payload"',
  },
  inputs: {
    asciiBody: 'aaaa',
    multibyteBody: 'aaa한 (replaces one 1-byte character with a 3-byte character)',
    styledSnapshot: 'asciiBody plus styles ["p{}"]',
  },
  expected:
    'Replacing one ASCII character with the 3-byte character 한 grows the measured payload by exactly 2 bytes; omitted styles measure the same as styles: []; adding a style entry grows the payload.',
  act: async () => {
    const asciiBytes = getSnapshotPayloadBytes({ body: 'aaaa' });
    const multibyteBytes = getSnapshotPayloadBytes({ body: 'aaa한' });
    const explicitEmptyStylesBytes = getSnapshotPayloadBytes({ body: 'aaaa', styles: [] });
    const styledBytes = getSnapshotPayloadBytes({ body: 'aaaa', styles: ['p{}'] });
    return {
      multibyteDelta: multibyteBytes - asciiBytes,
      emptyStylesEqualsOmitted: explicitEmptyStylesBytes === asciiBytes,
      styledGrowth: styledBytes - asciiBytes,
    };
  },
  assert: (actual, expect) => {
    expect(actual.multibyteDelta).toBe(2);
    expect(actual.emptyStylesEqualsOmitted).toBe(true);
    expect(actual.styledGrowth).toBeGreaterThan(0);
  },
});
