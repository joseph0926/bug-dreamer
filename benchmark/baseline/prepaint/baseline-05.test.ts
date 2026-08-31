import { defineScenario } from '@bug-dreamer/scenario';
import { getSnapshotPayloadBytes } from '@target/policy';

defineScenario({
  id: 'snapshot payload size counts UTF-8 bytes not string length',
  oracle: {
    basis: 'documentation',
    ref: 'packages/prepaint/README.md policy reference: "maxSnapshotBytes?: number - Default: 1 MiB, UTF-8 JSON payload"',
  },
  inputs: {
    snapshot: { body: '한글', styles: 'omitted' },
    serializedJson: '{"body":"한글","styles":[]}',
    jsonCharLength: 25,
    expectedUtf8Bytes: 29,
  },
  expected:
    'For a body of two Korean characters the JSON payload is 25 characters but 29 UTF-8 bytes (each Hangul syllable is 3 bytes), and getSnapshotPayloadBytes must report 29.',
  act: async () => {
    const bytes = getSnapshotPayloadBytes({ body: '한글' });
    const jsonCharLength = JSON.stringify({ body: '한글', styles: [] }).length;
    return { bytes, jsonCharLength };
  },
  assert: (actual, expect) => {
    expect(actual.jsonCharLength).toBe(25);
    expect(actual.bytes).toBe(29);
  },
});
