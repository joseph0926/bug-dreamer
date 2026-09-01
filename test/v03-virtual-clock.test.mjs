import assert from 'node:assert/strict';
import test from 'node:test';

import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EvaluatorInfrastructureError, createVirtualClock } from '../harness-v0.3/trust/virtual-clock.mjs';

test('virtual timers never fire without an advance and drain in due order', async () => {
  const clock = createVirtualClock(1000000000000);
  clock.install();
  try {
    const fired = [];
    setTimeout(() => fired.push('late'), 500);
    setTimeout(() => fired.push('early'), 100);
    await clock.drainMicrotasks();
    assert.deepEqual(fired, []);
    assert.equal(clock.pendingTimerCount(), 2);
    await clock.advance(500);
    assert.deepEqual(fired, ['early', 'late']);
    assert.equal(Date.now(), 1000000000500);
    assert.equal(clock.pendingTimerCount(), 0);
  } finally {
    clock.uninstall();
  }
});

test('advanceToNextTimer fires the earliest timer and reports an empty timer set', async () => {
  const clock = createVirtualClock(1000000000000);
  clock.install();
  try {
    assert.equal(await clock.advanceToNextTimer(), false);
    let resolved = false;
    const chained = new Promise((resolve) => {
      setTimeout(resolve, 1000);
    }).then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => {
      resolved = true;
    });
    assert.equal(await clock.advanceToNextTimer(), true);
    await chained;
    assert.equal(resolved, true);
    assert.equal(Date.now(), 1000000001000);
  } finally {
    clock.uninstall();
  }
});

test('timer handles support clear, unref, and setInterval fails deterministically', async () => {
  const clock = createVirtualClock(1000000000000);
  clock.install();
  try {
    const handle = setTimeout(() => {
      throw new Error('cleared timer fired');
    }, 0);
    assert.equal(handle.unref(), handle);
    assert.equal(handle.ref(), handle);
    clearTimeout(handle);
    assert.equal(clock.pendingTimerCount(), 0);
    await clock.advance(10);
    assert.throws(() => setInterval(() => {}, 1), EvaluatorInfrastructureError);
    assert.throws(() => clearInterval(1), EvaluatorInfrastructureError);
    assert.throws(() => setInterval(() => {}, 1), /not a registered virtual timer API/u);
  } finally {
    clock.uninstall();
  }
});

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_TX_SPECIFIER = 'bug-dreamer-test:tx';
const FAKE_TX_SOURCE = `export function startTransaction() {
  return {
    async run(step) {
      globalThis.__bugDreamerTestTxHook();
      return step();
    },
    async commit() {},
  };
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@firsttx/tx') return { url: FAKE_TX_SPECIFIER, shortCircuit: true };
    if (specifier === '/consumer/evaluator/virtual-clock.mjs') {
      return { url: pathToFileURL(path.join(repositoryRoot, 'harness-v0.3/trust/virtual-clock.mjs')).href, shortCircuit: true };
    }
    if (specifier.startsWith('/consumer/evaluator/src/')) {
      return { url: pathToFileURL(path.join(repositoryRoot, 'src', specifier.slice('/consumer/evaluator/src/'.length))).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === FAKE_TX_SPECIFIER) return { format: 'module', source: FAKE_TX_SOURCE, shortCircuit: true };
    return nextLoad(url, context);
  },
});

function timeoutPlan() {
  return {
    actions: [
      {
        instanceId: 'action-0001',
        actionId: 'tx.start',
        adapterId: 'tx.start/v1',
        arguments: { transactionId: 'infra', timeoutMs: 1000, transition: false },
        bind: { name: 'tx', type: 'tx-handle' },
      },
      {
        instanceId: 'action-0002',
        actionId: 'tx.run',
        adapterId: 'tx.run/v1',
        arguments: { tx: { $binding: 'tx' }, outcome: 'return', value: null, errorName: null, errorMessage: null, log: null, retry: null },
        bind: null,
      },
    ],
    scheduleControls: [],
  };
}

async function runInterpretWithHook(hook) {
  const { interpret } = await import(pathToFileURL(path.join(repositoryRoot, 'harness-v0.3/trust/evaluator.mjs')).href);
  const clock = createVirtualClock(1000000000000);
  globalThis.__bugDreamerTestTxHook = hook;
  clock.install();
  try {
    return { observations: await interpret(timeoutPlan(), clock), thrown: null };
  } catch (error) {
    return { observations: null, thrown: error };
  } finally {
    clock.uninstall();
    delete globalThis.__bugDreamerTestTxHook;
  }
}

test('interval use inside a run propagates as an infrastructure error instead of a product observation', async () => {
  const direct = await runInterpretWithHook(() => setInterval(() => {}, 1));
  assert.equal(direct.observations, null);
  assert.ok(direct.thrown instanceof EvaluatorInfrastructureError);

  const cleared = await runInterpretWithHook(() => clearInterval(1));
  assert.equal(cleared.observations, null);
  assert.ok(cleared.thrown instanceof EvaluatorInfrastructureError);

  const wrapped = await runInterpretWithHook(() => {
    try {
      setInterval(() => {}, 1);
    } catch (error) {
      throw new Error('step failed', { cause: new Error('adapter failed', { cause: error }) });
    }
  });
  assert.equal(wrapped.observations, null);
  assert.equal(wrapped.thrown.message, 'step failed');

  const product = await runInterpretWithHook(() => {});
  assert.equal(product.thrown, null);
  assert.deepEqual(product.observations.get('action-0002'), { kind: 'returned-value', fields: { value: null } });
});
