export function createVirtualClock(originMs) {
  let now = originMs;
  let nextHandle = 1;
  const timers = new Map();
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  return {
    now() {
      return now;
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
        return handle;
      };
      globalThis.clearTimeout = (handle) => {
        timers.delete(handle);
      };
    },
    uninstall() {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
    async advance(advanceMs) {
      const target = now + advanceMs;
      for (;;) {
        const dueEntries = [...timers.entries()]
          .filter(([, timer]) => timer.due <= target)
          .sort((first, second) => first[1].due - second[1].due || first[1].sequence - second[1].sequence);
        if (dueEntries.length === 0) break;
        const [handle, timer] = dueEntries[0];
        timers.delete(handle);
        now = Math.max(now, timer.due);
        timer.callback();
        await Promise.resolve();
      }
      now = target;
    },
  };
}
