import { defineScenario } from '@bug-dreamer/scenario';

defineScenario({
  id: 'synthetic blocked network access',
  oracle: {
    basis: 'declared-invariant',
    ref: 'docs/V0.1-CONTRACT.md: runner network control',
  },
  inputs: {
    url: 'http://192.0.2.1',
  },
  expected: 'The container cannot reach an external address.',
  act: async () => {
    const response = await fetch('http://192.0.2.1', {
      signal: AbortSignal.timeout(1_000),
    });
    return response.status;
  },
  assert: (actual, expect) => {
    expect(actual).toBe(200);
  },
});
