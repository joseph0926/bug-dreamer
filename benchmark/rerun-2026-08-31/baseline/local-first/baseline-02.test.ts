import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'unsubscribe stops delivery of later cross-tab messages for that key',
  oracle: {
    basis: 'public-type',
    ref: 'broadcast.ts subscribe() returns an unsubscribe function that removes the callback from the key listener set',
  },
  inputs: {
    key: 'cart',
    messages: 'one model-replaced message before unsubscribe, one identical message after',
  },
  expected:
    'The callback fires exactly once for the message sent before unsubscribing and never for the message sent after.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    let received = 0;
    const unsubscribe = broadcaster.subscribe('cart', () => {
      received += 1;
    });
    const otherTab = new BroadcastChannel('firsttx:models');
    const send = () => {
      otherTab.postMessage({
        type: 'model-replaced',
        key: 'cart',
        senderId: 'external-tab',
        timestamp: Date.now(),
      });
    };
    send();
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    const afterFirst = received;
    unsubscribe();
    send();
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    otherTab.close();
    broadcaster.close();
    return { afterFirst, final: received };
  },
  assert: (actual, expect) => {
    expect(actual.afterFirst).toBe(1);
    expect(actual.final).toBe(1);
  },
});
