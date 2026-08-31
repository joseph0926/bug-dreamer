import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'broadcaster degrades to silent no-op instead of crashing when BroadcastChannel is unavailable',
  oracle: {
    basis: 'existing-test',
    ref: 'INV-LF-06 — tests "should NOT crash when BroadcastChannel is undefined" and "should allow model operations in fallback mode" in packages/local-first/tests/broadcast.test.ts; fallback doc comment packages/local-first/src/broadcast.ts:33-36',
  },
  inputs: { broadcastChannelAvailable: false, operations: ['broadcast', 'subscribe', 'close'] },
  expected:
    'With BroadcastChannel deleted from the global scope, getInstance, broadcast, subscribe, unsubscribe, and close all complete without throwing and no cross-tab callback fires.',
  act: async () => {
    const globals = globalThis as { BroadcastChannel?: typeof BroadcastChannel };
    const original = globals.BroadcastChannel;
    try {
      delete globals.BroadcastChannel;
      const broadcaster = ModelBroadcaster.getInstance();
      let callbackFired = false;
      const unsubscribe = broadcaster.subscribe('fallback-key', () => {
        callbackFired = true;
      });
      broadcaster.broadcast({ type: 'model-patched', key: 'fallback-key' });
      broadcaster.broadcast({ type: 'model-deleted', key: 'fallback-key' });
      await new Promise<void>((r) => setTimeout(r, 50));
      unsubscribe();
      broadcaster.close();
      return { crashed: false, callbackFired };
    } catch (error) {
      return { crashed: true, callbackFired: false, errorName: (error as Error).name };
    } finally {
      globals.BroadcastChannel = original;
    }
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({ crashed: false, callbackFired: false });
  },
});
