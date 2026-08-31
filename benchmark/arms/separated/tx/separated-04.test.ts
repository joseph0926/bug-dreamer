import { defineScenario } from '@bug-dreamer/scenario';
import { executeWithRetry } from '@target/retry';

defineScenario({
  id: 'exponential backoff first delay equals delayMs and second delay doubles it',
  oracle: {
    basis: 'existing-test',
    ref: 'INV-TX-07 — test "should use exponential backoff correctly" in packages/tx/tests/retry.test.ts and packages/tx/README.md:765 example "100ms → 200ms → 400ms" (conflicts with the same FAQ line formula "delay × 2^attempt")',
  },
  inputs: { maxAttempts: 3, delayMs: 100, backoff: 'exponential' },
  expected:
    'With delayMs 100 and exponential backoff, the delay before the second attempt is about 100ms and before the third about 200ms (delayMs * 2^(attempt-1), first delay equals delayMs).',
  act: async () => {
    const timestamps: number[] = [];
    let caught = 'none';
    try {
      await executeWithRetry(
        async () => {
          timestamps.push(Date.now());
          throw new Error('always fails');
        },
        'step-0',
        { maxAttempts: 3, delayMs: 100, backoff: 'exponential' },
      );
    } catch (error) {
      caught = (error as Error).name;
    }
    const firstDelay = timestamps[1] - timestamps[0];
    const secondDelay = timestamps[2] - timestamps[1];
    return {
      attempts: timestamps.length,
      caught,
      firstDelayNearBase: firstDelay >= 85 && firstDelay < 170,
      secondDelayNearDouble: secondDelay >= 170 && secondDelay < 340,
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      attempts: 3,
      caught: 'RetryExhaustedError',
      firstDelayNearBase: true,
      secondDelayNearDouble: true,
    });
  },
});
