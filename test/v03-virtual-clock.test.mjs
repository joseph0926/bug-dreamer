import assert from 'node:assert/strict';
import test from 'node:test';

import { createVirtualClock } from '../harness-v0.3/trust/virtual-clock.mjs';

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
    assert.throws(() => setInterval(() => {}, 1), /not a registered virtual timer API/u);
  } finally {
    clock.uninstall();
  }
});
