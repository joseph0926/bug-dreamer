import { defineScenario } from '@bug-dreamer/scenario';
import { serializePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'serialized policy escapes html-sensitive characters yet round-trips through JSON.parse',
  oracle: {
    basis: 'declared-invariant',
    ref: 'policy.ts serializePrepaintPolicy(): output is meant for inline script injection, so <, > and & must never appear raw while remaining valid JSON',
  },
  inputs: {
    policy: {
      routes: ['/a</script><script>'],
      ttlMs: 5000,
      maxSnapshotBytes: 1024,
      includeStyles: false,
    },
  },
  expected:
    'The serialized string contains no raw <, > or & characters and JSON.parse recovers the original route and includeStyles flag.',
  act: async () => {
    const serialized = serializePrepaintPolicy({
      routes: ['/a</script><script>'],
      ttlMs: 5000,
      maxSnapshotBytes: 1024,
      includeStyles: false,
    });
    const parsed = JSON.parse(serialized) as {
      routes: string[];
      includeStyles: boolean;
      ttlMs: number;
    };
    return {
      hasRawLt: serialized.includes('<'),
      hasRawGt: serialized.includes('>'),
      hasRawAmp: serialized.includes('&'),
      route: parsed.routes[0],
      includeStyles: parsed.includeStyles,
      ttlMs: parsed.ttlMs,
    };
  },
  assert: (actual, expect) => {
    expect(actual.hasRawLt).toBe(false);
    expect(actual.hasRawGt).toBe(false);
    expect(actual.hasRawAmp).toBe(false);
    expect(actual.route).toBe('/a</script><script>');
    expect(actual.includeStyles).toBe(false);
    expect(actual.ttlMs).toBe(5000);
  },
});
