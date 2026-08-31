import { defineScenario } from '@bug-dreamer/scenario';
import { executeWithRetry } from '@target/retry';

defineScenario({
  id: 'returns the first successful retry result',
  oracle: {
    basis: 'existing-test',
    ref: 'packages/tx/tests/retry.test.ts:13',
  },
  inputs: {
    stepId: 'step-1',
    maxAttempts: 1,
  },
  expected: 'The first successful attempt returns its value.',
  act: async () => executeWithRetry(async () => 'success', 'step-1', { maxAttempts: 1 }),
  assert: (actual, expect) => {
    expect(actual).toBe('success');
  },
});
