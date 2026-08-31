import { spawn } from 'node:child_process';

import { emit } from './events.mjs';

const moduleDir = process.env.BUG_DREAMER_MODULE_DIR;

if (moduleDir === undefined || moduleDir.length === 0) {
  process.stderr.write('BUG_DREAMER_MODULE_DIR is not set\n');
  process.exit(126);
}

emit('P1');

const child = spawn(
  `${moduleDir}/node_modules/.bin/vitest`,
  ['run', '.bug-dreamer/generated.test.ts', '--config', `${moduleDir}/.bug-dreamer/vitest.config.mjs`],
  {
    cwd: moduleDir,
    env: process.env,
    stdio: 'inherit',
  },
);

child.once('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 126;
});

child.once('close', (exitCode, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = exitCode ?? 1;
});
