import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'unsubscribing another listener during dispatch does not skip its delivery',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/local-first/src/broadcast.ts subscribe(): "Subscribe to model changes from other tabs" — every callback subscribed at the moment a message arrives must be invoked for that message',
  },
  inputs: {
    listeners: [
      { key: 'profile', behavior: 'unsubscribes the second listener' },
      { key: 'profile', behavior: 'records that it was called' },
    ],
    message: { type: 'model-patched', key: 'profile', senderId: 'external-tab' },
  },
  expected:
    'When a broadcast message arrives, both listeners were subscribed, so the second listener must still be invoked even though the first listener unsubscribes it during the same dispatch.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    let secondCalled = false;
    let unsubscribeSecond: () => void = () => {};
    const unsubscribeFirst = broadcaster.subscribe('profile', () => {
      unsubscribeSecond();
    });
    unsubscribeSecond = broadcaster.subscribe('profile', () => {
      secondCalled = true;
    });
    const external = new BroadcastChannel('firsttx:models');
    external.postMessage({
      type: 'model-patched',
      key: 'profile',
      senderId: 'external-tab',
      timestamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    unsubscribeFirst();
    external.close();
    broadcaster.close();
    return { secondCalled };
  },
  assert: (actual, expect) => {
    expect(actual.secondCalled).toBe(true);
  },
});
