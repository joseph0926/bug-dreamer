import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'broadcast after close degrades gracefully instead of throwing',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/local-first/src/broadcast.ts FallbackChannel: "Provides no-op methods to allow graceful degradation without crashes" — broadcasting when the channel is unavailable must not throw',
  },
  inputs: {
    sequence: ['getInstance', 'close', 'broadcast model-patched for key cart'],
  },
  expected:
    'Calling broadcast() after close() must not throw; the broadcaster either no-ops or transparently recovers, matching the declared graceful-degradation behavior.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    broadcaster.close();
    try {
      broadcaster.broadcast({ type: 'model-patched', key: 'cart' });
      return 'no-throw';
    } catch (error) {
      return error instanceof Error
        ? error.name
        : String((error as { name?: unknown })?.name ?? error);
    }
  },
  assert: (actual, expect) => {
    expect(actual).toBe('no-throw');
  },
});
