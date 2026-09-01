export function createVirtualClock(originMs) {
  let now = originMs;
  let nextHandle = 1;
  const timers = new Map();
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalSetImmediate = globalThis.setImmediate;

  const drainMicrotasks = () => new Promise((resolve) => {
    originalSetImmediate(resolve);
  });

  const fireTimer = (handle) => {
    const timer = timers.get(handle);
    timers.delete(handle);
    now = Math.max(now, timer.due);
    timer.callback();
  };

  const earliestHandle = (limitMs) => {
    const dueEntries = [...timers.entries()]
      .filter(([, timer]) => limitMs === null || timer.due <= limitMs)
      .sort((first, second) => first[1].due - second[1].due || first[1].sequence - second[1].sequence);
    return dueEntries.length === 0 ? null : dueEntries[0][0];
  };

  return {
    now() {
      return now;
    },
    pendingTimerCount() {
      return timers.size;
    },
    install() {
      Date.now = () => now;
      globalThis.setTimeout = (callback, delay = 0, ...callbackArgs) => {
        const handle = nextHandle;
        nextHandle += 1;
        const numericDelay = Number(delay);
        timers.set(handle, {
          due: now + (Number.isFinite(numericDelay) && numericDelay > 0 ? numericDelay : 0),
          sequence: handle,
          callback: () => callback(...callbackArgs),
        });
        return {
          virtualHandle: handle,
          ref() {
            return this;
          },
          unref() {
            return this;
          },
          hasRef() {
            return true;
          },
          [Symbol.toPrimitive]() {
            return handle;
          },
        };
      };
      globalThis.clearTimeout = (handle) => {
        timers.delete(typeof handle === 'object' && handle !== null ? handle.virtualHandle : handle);
      };
      globalThis.setInterval = () => {
        throw new Error('setInterval is not a registered virtual timer API');
      };
      globalThis.clearInterval = () => {
        throw new Error('clearInterval is not a registered virtual timer API');
      };
    },
    uninstall() {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
    async advance(advanceMs) {
      const target = now + advanceMs;
      for (;;) {
        const handle = earliestHandle(target);
        if (handle === null) break;
        fireTimer(handle);
        await drainMicrotasks();
      }
      now = target;
    },
    async advanceToNextTimer() {
      const handle = earliestHandle(null);
      if (handle === null) return false;
      fireTimer(handle);
      await drainMicrotasks();
      return true;
    },
    drainMicrotasks,
  };
}
