import { spawn } from 'node:child_process';

import { emit } from './events.mjs';

emit('P1');

const child = spawn(
  '/workspace/packages/tx/node_modules/.bin/vitest',
  [
    'run',
    '.bug-dreamer/generated.test.ts',
    '--config',
    '/workspace/packages/tx/.bug-dreamer/vitest.config.mjs',
  ],
  {
    cwd: '/workspace/packages/tx',
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
