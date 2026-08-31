import { spawn } from 'node:child_process';

import { MAX_LOG_LENGTH } from './constants.mjs';

function appendLog(current, chunk) {
  if (current.length >= MAX_LOG_LENGTH) return current;
  return current + chunk.toString().slice(0, MAX_LOG_LENGTH - current.length);
}

export function runCommand(command, args, options = {}) {
  const { cwd, timeoutMs, onTimeout } = options;

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cleanupPromise = Promise.resolve();
    let timer;

    child.stdout.on('data', (chunk) => {
      stdout = appendLog(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLog(stderr, chunk);
    });
    child.once('error', reject);

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        cleanupPromise = Promise.resolve(onTimeout?.()).catch((error) => {
          stderr = appendLog(stderr, `\nCleanup failed: ${error.message}`);
        });
      }, timeoutMs);
    }

    child.once('close', async (exitCode, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      await cleanupPromise;
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
  });
}
