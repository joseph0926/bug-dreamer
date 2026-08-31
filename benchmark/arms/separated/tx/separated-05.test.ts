import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'RetryExhaustedError carries stepId, attempts equal to maxAttempts, and all attempt errors in chronological order',
  oracle: {
    basis: 'existing-test',
    ref: 'INV-TX-06 — tests "should include all attempt errors in RetryExhaustedError" in packages/tx/tests/transaction.test.ts and "should include all errors in RetryExhaustedError" in packages/tx/tests/retry.test.ts',
  },
  inputs: { maxAttempts: 3, delayMs: 1, backoff: 'linear' },
  expected:
    'When every attempt of a step fails, tx.run() rejects with RetryExhaustedError whose attempts equals maxAttempts, whose stepId matches step-<index>, and whose errors list every per-attempt error in chronological order.',
  act: async () => {
    const tx = new Transaction();
    let attempt = 0;
    try {
      await tx.run(
        async () => {
          attempt++;
          throw new Error(`attempt-${attempt} failed`);
        },
        { retry: { maxAttempts: 3, delayMs: 1, backoff: 'linear' } },
      );
      return { caught: false };
    } catch (error) {
      const e = error as {
        name: string;
        stepId?: string;
        attempts?: number;
        errors?: Error[];
      };
      return {
        caught: true,
        name: e.name,
        stepIdMatches: typeof e.stepId === 'string' && /^step-\d+$/.test(e.stepId),
        attempts: e.attempts,
        messages: (e.errors ?? []).map((x) => x.message),
      };
    }
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      caught: true,
      name: 'RetryExhaustedError',
      stepIdMatches: true,
      attempts: 3,
      messages: ['attempt-1 failed', 'attempt-2 failed', 'attempt-3 failed'],
    });
  },
});
