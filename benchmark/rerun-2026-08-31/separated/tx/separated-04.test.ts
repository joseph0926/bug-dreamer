import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';
import { RetryExhaustedError } from '@target/errors';

defineScenario({
  id: 'exhausted retries reject with RetryExhaustedError carrying stepId, attempts and all attempt errors in chronological order',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-TX-06 — separated invariant catalog, sourced from tx/tests/transaction.test.ts "should include all attempt errors in RetryExhaustedError" and tx/tests/retry.test.ts "should include all errors in RetryExhaustedError"',
  },
  inputs: {
    step: 'always throws attempt-<n>',
    retry: { maxAttempts: 3, delayMs: 1, backoff: 'linear' },
  },
  expected:
    'run() rejects with RetryExhaustedError whose stepId is step-0, attempts is 3, and errors are [attempt-1, attempt-2, attempt-3] in chronological order.',
  act: async () => {
    const tx = new Transaction();
    let attempt = 0;
    let caught: unknown = null;
    try {
      await tx.run(
        async () => {
          attempt += 1;
          throw new Error(`attempt-${attempt}`);
        },
        { retry: { maxAttempts: 3, delayMs: 1, backoff: 'linear' } },
      );
    } catch (error) {
      caught = error;
    }
    const err = caught as RetryExhaustedError;
    return {
      isRetryExhausted: caught instanceof RetryExhaustedError,
      name: err?.name,
      stepId: err?.stepId,
      attempts: err?.attempts,
      messages: Array.isArray(err?.errors) ? err.errors.map((e) => e.message) : [],
      callCount: attempt,
    };
  },
  assert: (actual, expect) => {
    expect(actual.isRetryExhausted).toBe(true);
    expect(actual.name).toBe('RetryExhaustedError');
    expect(actual.stepId).toBe('step-0');
    expect(actual.attempts).toBe(3);
    expect(actual.callCount).toBe(3);
    expect(actual.messages).toEqual(['attempt-1', 'attempt-2', 'attempt-3']);
  },
});
