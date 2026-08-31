import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'duplicate subscribe of same callback survives a single unsubscribe',
  oracle: {
    basis: 'public-type',
    ref: 'packages/local-first/src/broadcast.ts subscribe(key, callback): () => void — each call returns its own unsubscribe function that removes only the subscription it created',
  },
  inputs: {
    subscriptions: {
      key: 'cart',
      sameCallbackSubscribedTimes: 2,
      unsubscribeCalls: 1,
    },
    message: { type: 'model-replaced', key: 'cart', senderId: 'external-tab' },
  },
  expected:
    'After subscribing the same callback twice for the same key and calling only the first unsubscribe, the remaining subscription still delivers the next broadcast, so the callback fires once.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    let calls = 0;
    const callback = () => {
      calls++;
    };
    const unsubscribeA = broadcaster.subscribe('cart', callback);
    const unsubscribeB = broadcaster.subscribe('cart', callback);
    unsubscribeA();
    const external = new BroadcastChannel('firsttx:models');
    external.postMessage({
      type: 'model-replaced',
      key: 'cart',
      senderId: 'external-tab',
      timestamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    unsubscribeB();
    external.close();
    broadcaster.close();
    return { callsAfterOneUnsubscribe: calls };
  },
  assert: (actual, expect) => {
    expect(actual.callsAfterOneUnsubscribe).toBe(1);
  },
});
