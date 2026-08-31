import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'broadcast after close degrades gracefully instead of throwing',
  oracle: {
    basis: 'declared-invariant',
    ref: 'src/broadcast.ts FallbackChannel docstring: "Provides no-op methods to allow graceful degradation without crashes"; packages/local-first/README.md "Without BroadcastChannel, cross-tab propagation is skipped"',
  },
  inputs: {
    sequence:
      'singleton broadcaster is closed (teardown/HMR cleanup), then a late patch triggers broadcast()',
  },
  expected:
    'A broadcast issued after close() is skipped as unavailable cross-tab propagation and does not throw',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    broadcaster.close();
    try {
      broadcaster.broadcast({ type: 'model-patched', key: 'cart' });
      return 'no-throw';
    } catch (error) {
      const e = error as Error;
      return e.name || 'threw';
    }
  },
  assert: (actual, expect) => {
    expect(actual).toBe('no-throw');
  },
});
