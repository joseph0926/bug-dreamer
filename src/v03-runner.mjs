export const CONTAINER_REMOVE_GRACE_MS = 5000;

export function createCaseRunner({ spawn, budget, removeGraceMs = CONTAINER_REMOVE_GRACE_MS }) {
  if (typeof spawn !== 'function') throw new TypeError('createCaseRunner requires a spawn function');
  if (budget === null || typeof budget !== 'object') throw new TypeError('createCaseRunner requires an execution budget');
  const { evaluationTimeoutMs, stdoutLimitBytes, stderrLimitBytes, recordedOutputBytes } = budget;
  if (!Number.isInteger(evaluationTimeoutMs) || evaluationTimeoutMs <= 0) throw new TypeError('Execution budget timeout is invalid');
  if (!Number.isInteger(stdoutLimitBytes) || !Number.isInteger(stderrLimitBytes)) throw new TypeError('Execution budget output limits are invalid');
  if (!Number.isInteger(recordedOutputBytes) || recordedOutputBytes < 0) throw new TypeError('Execution budget record size is invalid');
  if (!Number.isInteger(removeGraceMs) || removeGraceMs <= 0) throw new TypeError('Container removal grace is invalid');

  return function runCase(args, containerName) {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const streams = {
        stdout: { limit: stdoutLimitBytes, bytes: 0, recorded: [], recordedBytes: 0 },
        stderr: { limit: stderrLimitBytes, bytes: 0, recorded: [], recordedBytes: 0 },
      };
      let timedOut = false;
      let outputTruncated = false;
      let cleanupError = null;
      let stopped = false;
      let cleanupDone = false;
      let closed = false;
      let closeExitCode = null;
      let settled = false;
      let stopTimer = null;

      const timer = setTimeout(() => {
        timedOut = true;
        void stop();
      }, evaluationTimeoutMs);

      const finish = (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stopTimer !== null) clearTimeout(stopTimer);
        resolve({
          exitCode: exitCode ?? null,
          stdout: Buffer.concat(streams.stdout.recorded).toString('utf8'),
          stderr: Buffer.concat(streams.stderr.recorded).toString('utf8'),
          stdoutBytes: streams.stdout.bytes,
          stderrBytes: streams.stderr.bytes,
          timedOut,
          outputTruncated,
          cleanupError,
        });
      };

      const removeContainer = () => new Promise((resolveRemove) => {
        let removeSettled = false;
        let graceTimer = null;
        const settleRemove = (value) => {
          if (removeSettled) return;
          removeSettled = true;
          if (graceTimer !== null) clearTimeout(graceTimer);
          resolveRemove(value);
        };
        let remover;
        try {
          remover = spawn('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
        } catch (error) {
          settleRemove(`container removal could not start: ${error.message}`);
          return;
        }
        graceTimer = setTimeout(() => {
          remover.kill('SIGKILL');
          settleRemove(`container removal exceeded ${removeGraceMs} ms`);
        }, removeGraceMs);
        remover.once('error', (error) => settleRemove(`container removal failed: ${error.message}`));
        remover.once('close', (exitCode) => settleRemove(exitCode === 0 ? null : `docker rm --force exited with ${exitCode}`));
      });

      const stop = async () => {
        if (stopped) return;
        stopped = true;
        try {
          child.kill('SIGTERM');
          cleanupError = await removeContainer();
        } catch (error) {
          cleanupError = `container stop failed: ${error.message}`;
        }
        cleanupDone = true;
        if (closed) {
          finish(closeExitCode);
          return;
        }
        if (cleanupError !== null) child.kill('SIGKILL');
        stopTimer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(null);
        }, removeGraceMs);
      };

      const collect = (name) => (chunk) => {
        const stream = streams[name];
        stream.bytes += chunk.length;
        if (stream.recordedBytes < recordedOutputBytes) {
          const slice = chunk.subarray(0, recordedOutputBytes - stream.recordedBytes);
          stream.recorded.push(slice);
          stream.recordedBytes += slice.length;
        }
        if (stream.bytes > stream.limit) {
          outputTruncated = true;
          void stop();
        }
      };

      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stopTimer !== null) clearTimeout(stopTimer);
        reject(error);
      });
      child.once('close', (exitCode) => {
        closed = true;
        closeExitCode = exitCode;
        if (!stopped || cleanupDone) finish(exitCode);
      });
    });
  };
}
