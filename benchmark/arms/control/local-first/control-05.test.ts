import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'broadcaster routes a foreign tab message only to subscribers of the matching key',
  oracle: {
    basis: 'documentation',
    ref: 'packages/local-first/src/broadcast.ts ModelBroadcaster.subscribe/setupListener: messages from other senders invoke callbacks registered for message.key only',
  },
  inputs: { channelName: 'firsttx:models', subscribedKey: 'user', otherKey: 'cart' },
  expected:
    'A message posted by another tab for key user triggers the user subscriber exactly once, and a message for key cart triggers nothing.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    const received: string[] = [];
    const unsubscribe = broadcaster.subscribe('user', () => {
      received.push('user');
    });

    const externalTab = new BroadcastChannel('firsttx:models');
    externalTab.postMessage({
      type: 'model-patched',
      key: 'user',
      senderId: 'external-tab',
      timestamp: Date.now(),
    });
    externalTab.postMessage({
      type: 'model-replaced',
      key: 'cart',
      senderId: 'external-tab',
      timestamp: Date.now(),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    unsubscribe();
    externalTab.close();
    broadcaster.close();

    return { received };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({ received: ['user'] });
  },
});
