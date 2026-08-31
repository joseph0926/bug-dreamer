import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'calling the same unsubscribe twice removes only that callback and leaves siblings on the key intact',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/local-first/src/broadcast.ts subscribe(): the returned unsubscribe removes exactly the registered callback; repeated calls are safe no-ops',
  },
  inputs: { channelName: 'firsttx:models', key: 'user' },
  expected:
    'After unsubscribing callback A twice, a foreign tab message for the key still reaches callback B exactly once and never reaches A.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    const received: string[] = [];

    const unsubA = broadcaster.subscribe('user', () => {
      received.push('A');
    });
    broadcaster.subscribe('user', () => {
      received.push('B');
    });

    unsubA();
    unsubA();

    const externalTab = new BroadcastChannel('firsttx:models');
    externalTab.postMessage({
      type: 'model-patched',
      key: 'user',
      senderId: 'external-tab',
      timestamp: Date.now(),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    externalTab.close();
    broadcaster.close();

    return { received };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({ received: ['B'] });
  },
});
