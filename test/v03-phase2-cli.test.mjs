import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('spec and trust validators succeed through the public CLI', async () => {
  for (const subcommand of ['spec', 'trust']) {
    const result = await execFileAsync(process.execPath, ['scripts/validate-v03.mjs', subcommand], { cwd: repositoryRoot });
    assert.match(result.stdout, new RegExp(`"status":"ok","subcommand":"${subcommand}"`, 'u'));
  }
});

test('Phase 2 validators reject arbitrary options as invalid usage', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/validate-v03.mjs', 'trust', '--result', 'elsewhere'], { cwd: repositoryRoot }),
    (error) => error.code === 2 && error.stderr.includes('Usage:'),
  );
});

test('Phase 3 and later validators remain explicitly unimplemented', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/validate-v03.mjs', 'operators'], { cwd: repositoryRoot }),
    (error) => error.code === 1 && error.stderr.includes('not implemented yet'),
  );
});
