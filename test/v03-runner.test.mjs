import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createCaseRunner } from '../src/v03-runner.mjs';

const BUDGET = { evaluationTimeoutMs: 25, stdoutLimitBytes: 16, stderrLimitBytes: 16, recordedOutputBytes: 8 };
const GRACE_MS = 25;

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    return true;
  }
}

function createFakeSpawn(script) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new FakeChild();
    const call = { command, args, options, child };
    calls.push(call);
    queueMicrotask(() => script(call));
    return child;
  };
  return { spawn, calls };
}

function runnerWith(script) {
  const { spawn, calls } = createFakeSpawn(script);
  return { runCase: createCaseRunner({ spawn, budget: BUDGET, removeGraceMs: GRACE_MS }), calls };
}

function removeCalls(calls) {
  return calls.filter((call) => call.args[0] === 'rm');
}

test('records a normal container exit without touching the cleanup path', async () => {
  const { runCase, calls } = runnerWith((call) => {
    call.child.stdout.emit('data', Buffer.from('ok'));
    call.child.stderr.emit('data', Buffer.from('warn'));
    call.child.emit('close', 0);
  });
  const record = await runCase(['run', '--name', 'case-a', 'sha256:image'], 'case-a');
  assert.deepEqual(record, {
    exitCode: 0,
    stdout: 'ok',
    stderr: 'warn',
    stdoutBytes: 2,
    stderrBytes: 4,
    timedOut: false,
    outputTruncated: false,
    cleanupError: null,
  });
  assert.equal(removeCalls(calls).length, 0);
  assert.deepEqual(calls[0].child.signals, []);
});

test('records a zero-byte stream as a complete empty record', async () => {
  const { runCase } = runnerWith((call) => {
    call.child.stdout.emit('data', Buffer.alloc(0));
    call.child.emit('close', 0);
  });
  const record = await runCase(['run', 'sha256:image'], 'case-empty');
  assert.equal(record.stdout, '');
  assert.equal(record.stdoutBytes, 0);
  assert.equal(record.stderr, '');
  assert.equal(record.stderrBytes, 0);
  assert.equal(record.exitCode, 0);
  assert.equal(record.cleanupError, null);
});

test('force-removes the container on timeout and reports a clean removal', async () => {
  const { runCase, calls } = runnerWith((call) => {
    if (call.args[0] !== 'rm') return;
    call.child.emit('close', 0);
    queueMicrotask(() => calls[0].child.emit('close', 137));
  });
  const record = await runCase(['run', '--name', 'case-timeout', 'sha256:image'], 'case-timeout');
  assert.equal(record.timedOut, true);
  assert.equal(record.outputTruncated, false);
  assert.equal(record.exitCode, 137);
  assert.equal(record.cleanupError, null);
  const removes = removeCalls(calls);
  assert.equal(removes.length, 1);
  assert.deepEqual(removes[0].args, ['rm', '--force', 'case-timeout']);
  assert.deepEqual(calls[0].child.signals, ['SIGTERM']);
});

test('records a failing container removal without losing the run record', async () => {
  const { runCase, calls } = runnerWith((call) => {
    if (call.args[0] !== 'rm') return;
    call.child.emit('close', 1);
  });
  const record = await runCase(['run', '--name', 'case-rm-fail', 'sha256:image'], 'case-rm-fail');
  assert.equal(record.timedOut, true);
  assert.equal(record.exitCode, null);
  assert.equal(record.cleanupError, 'docker rm --force exited with 1');
  assert.deepEqual(calls[0].child.signals, ['SIGTERM', 'SIGKILL', 'SIGKILL']);
});

test('bounds a hanging container removal and still resolves once', async () => {
  const { runCase, calls } = runnerWith((call) => {
    if (call.args[0] !== 'rm') return;
  });
  const record = await runCase(['run', '--name', 'case-rm-hang', 'sha256:image'], 'case-rm-hang');
  assert.equal(record.timedOut, true);
  assert.equal(record.exitCode, null);
  assert.equal(record.cleanupError, `container removal exceeded ${GRACE_MS} ms`);
  const removes = removeCalls(calls);
  assert.deepEqual(removes[0].child.signals, ['SIGKILL']);
  calls[0].child.emit('close', 137);
  assert.equal(record.exitCode, null);
});

test('resolves after the grace window when the container never closes', async () => {
  const { runCase, calls } = runnerWith((call) => {
    if (call.args[0] !== 'rm') return;
    call.child.emit('close', 0);
  });
  const record = await runCase(['run', '--name', 'case-no-close', 'sha256:image'], 'case-no-close');
  assert.equal(record.timedOut, true);
  assert.equal(record.exitCode, null);
  assert.equal(record.cleanupError, null);
  assert.deepEqual(calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
});

test('stops the run when stdout exceeds its budget and caps the recorded bytes', async () => {
  const { runCase, calls } = runnerWith((call) => {
    if (call.args[0] === 'rm') {
      call.child.emit('close', 0);
      queueMicrotask(() => calls[0].child.emit('close', 137));
      return;
    }
    call.child.stdout.emit('data', Buffer.from('abcdefghijklmnopqrstuvwxyz'));
  });
  const record = await runCase(['run', '--name', 'case-overflow', 'sha256:image'], 'case-overflow');
  assert.equal(record.outputTruncated, true);
  assert.equal(record.timedOut, false);
  assert.equal(record.stdoutBytes, 26);
  assert.equal(record.stdout, 'abcdefgh');
  assert.equal(record.exitCode, 137);
  assert.equal(removeCalls(calls).length, 1);
});

test('rejects a spawn failure before the run record is produced', async () => {
  const { runCase } = runnerWith((call) => {
    call.child.emit('error', new Error('docker is unavailable'));
  });
  await assert.rejects(runCase(['run', 'sha256:image'], 'case-error'), /docker is unavailable/);
});
