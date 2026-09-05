import { EvaluatorInfrastructureError, isEvaluatorInfrastructureError } from '../trust/virtual-clock.mjs';

function containsInfrastructureError(value, seen = new Set()) {
  if (isEvaluatorInfrastructureError(value)) return true;
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return ['cause', 'errors', 'failures'].some((key) => {
    const nested = value[key];
    return Array.isArray(nested)
      ? nested.some((item) => containsInfrastructureError(item, seen))
      : containsInfrastructureError(nested, seen);
  });
}

export function rethrowInfrastructureError(error) {
  if (containsInfrastructureError(error)) throw error;
}

export function failInfrastructure(message) {
  throw new EvaluatorInfrastructureError(message);
}

export async function settleTxPromise(promise, runtime, label) {
  if (typeof runtime?.settle === 'function') return runtime.settle(promise, label);
  const clock = runtime?.clock ?? runtime?.virtualClock;
  if (clock === undefined) return promise;
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (;;) {
    for (let hop = 0; hop < 8 && !settled; hop += 1) await clock.drainMicrotasks();
    if (settled) return promise;
    if (!await clock.advanceToNextTimer()) {
      failInfrastructure(`Execution is blocked without a pending virtual timer: ${label}`);
    }
  }
}

export async function applyVirtualAdvances(scheduleControls, instanceId, runtime) {
  for (const control of scheduleControls) {
    if (control.kind !== 'virtual-time-advance' || control.afterInstanceId !== instanceId) continue;
    const clock = runtime?.clock ?? runtime?.virtualClock;
    if (clock === undefined || typeof clock.advance !== 'function') {
      failInfrastructure(`Virtual-time control has no registered clock: ${instanceId}`);
    }
    await clock.advance(control.advanceMs);
  }
}
