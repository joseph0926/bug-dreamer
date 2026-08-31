import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'keeps other subscribers after one unsubscribes',
  oracle: {
    basis: 'public-type',
    ref: 'packages/local-first ModelBroadcaster.subscribe returns an unsubscribe for that callback only',
  },
  inputs: {
    subscribersOnSameKey: 2,
    unsubscribed: 1,
  },
  expected: 'Unsubscribing one callback leaves the other callback receiving cross-tab updates.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    const raw = new BroadcastChannel('firsttx:models');

    let secondCalls = 0;
    const unsubscribeFirst = broadcaster.subscribe('shared', () => {});
    broadcaster.subscribe('shared', () => {
      secondCalls += 1;
    });
    unsubscribeFirst();

    raw.postMessage({
      type: 'model-patched',
      key: 'shared',
      senderId: 'other-tab',
      timestamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    raw.close();
    broadcaster.close();
    return secondCalls;
  },
  assert: (actual, expect) => {
    expect(actual).toBe(1);
  },
});
