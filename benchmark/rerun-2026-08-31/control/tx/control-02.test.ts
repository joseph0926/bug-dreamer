import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'step failure without retry config rethrows the original error after rollback',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/README.md "Automatic Rollback" list item 4: "Re-throw original error" (example steps declare no retry config)',
  },
  inputs: {
    step: 'single step with no retry option that throws TypeError("original-boom")',
  },
  expected:
    'The caller catches the original TypeError with message "original-boom", not a wrapper error type',
  act: async () => {
    const tx = new Transaction({ timeout: 5000 });
    try {
      await tx.run(async () => {
        throw new TypeError('original-boom');
      });
      return { name: 'no-error', message: '' };
    } catch (error) {
      const e = error as Error;
      return { name: e.name, message: e.message };
    }
  },
  assert: (actual, expect) => {
    expect(actual.name).toBe('TypeError');
    expect(actual.message).toBe('original-boom');
  },
});
