import { defineScenario } from '@bug-dreamer/scenario';
import { serializePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'serialized policy containing script-breaking characters carries no raw angle brackets or ampersands',
  oracle: {
    basis: 'documentation',
    ref: 'packages/prepaint/src/policy.ts serializePrepaintPolicy: escapes &, <, >, U+2028 and U+2029 so the output is safe to inline in a script tag',
  },
  inputs: { route: '/page?a=1&b=2</script><script>alert(1)</script>', ttlMs: 1000 },
  expected:
    'Serializing a policy whose route contains </script> and & produces a JSON string with only unicode-escaped forms of angle brackets and ampersands and no raw occurrences.',
  act: async () => {
    const serialized = serializePrepaintPolicy({
      routes: ['/page?a=1&b=2</script><script>alert(1)</script>'],
      ttlMs: 1000,
    });

    return {
      hasRawLt: serialized.includes('<'),
      hasRawGt: serialized.includes('>'),
      hasRawAmp: serialized.includes('&'),
      hasEscapedLt: serialized.includes('\\u003c'),
      hasEscapedGt: serialized.includes('\\u003e'),
      hasEscapedAmp: serialized.includes('\\u0026'),
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      hasRawLt: false,
      hasRawGt: false,
      hasRawAmp: false,
      hasEscapedLt: true,
      hasEscapedGt: true,
      hasEscapedAmp: true,
    });
  },
});
