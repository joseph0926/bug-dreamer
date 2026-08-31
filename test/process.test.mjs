import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_LOG_LENGTH } from '../src/constants.mjs';
import { runCommand } from '../src/process.mjs';

test('truncates output beyond the log limit and flags it', async () => {
  const result = await runCommand(process.execPath, [
    '-e',
    `process.stdout.write('x'.repeat(${MAX_LOG_LENGTH + 1024}))`,
  ]);

  assert.equal(result.stdout.length, MAX_LOG_LENGTH);
  assert.equal(result.truncated, true);
});

test('keeps empty output untruncated', async () => {
  const result = await runCommand(process.execPath, ['-e', '']);

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.truncated, false);
  assert.equal(result.exitCode, 0);
});
