import { spawn } from 'node:child_process';

import { MAX_LOG_LENGTH } from './constants.mjs';

function appendLog(log, chunk) {
  const text = chunk.toString();
  if (log.text.length + text.length > MAX_LOG_LENGTH) log.truncated = true;
  if (log.text.length >= MAX_LOG_LENGTH) return;
  log.text += text.slice(0, MAX_LOG_LENGTH - log.text.length);
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
    const stdout = { text: '', truncated: false };
    const stderr = { text: '', truncated: false };
    let timedOut = false;
    let cleanupPromise = Promise.resolve();
    let timer;

    child.stdout.on('data', (chunk) => {
      appendLog(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      appendLog(stderr, chunk);
    });
    child.once('error', (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        cleanupPromise = Promise.resolve(onTimeout?.()).catch((error) => {
          appendLog(stderr, `\nCleanup failed: ${error.message}`);
        });
      }, timeoutMs);
    }

    child.once('close', async (exitCode, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      await cleanupPromise;
      resolve({
        exitCode,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
  });
}
