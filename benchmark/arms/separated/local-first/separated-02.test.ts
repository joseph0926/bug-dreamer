import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'broadcast delivery is keyed and a message for an unsubscribed key is handled without effect',
  oracle: {
    basis: 'existing-test',
    ref: 'INV-LF-04 — tests "should only reload affected model" and "should broadcast different keys independently" in packages/local-first/tests/broadcast.test.ts',
  },
  inputs: {
    subscribedKeys: ['model-a', 'model-b'],
    messageKeys: ['model-a', 'model-without-subscribers'],
  },
  expected:
    'A broadcast for model-a invokes only model-a subscribers exactly once, never model-b subscribers, and a message for a key with no subscribers is handled without invoking anything.',
  act: async () => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const broadcaster = ModelBroadcaster.getInstance();
    const probe = new BroadcastChannel('firsttx:models');
    try {
      const counts = { a: 0, b: 0 };
      const unsubA = broadcaster.subscribe('model-a', () => {
        counts.a++;
      });
      const unsubB = broadcaster.subscribe('model-b', () => {
        counts.b++;
      });
      probe.postMessage({
        type: 'model-replaced',
        key: 'model-a',
        senderId: 'other-tab',
        timestamp: Date.now(),
      });
      probe.postMessage({
        type: 'model-patched',
        key: 'model-without-subscribers',
        senderId: 'other-tab',
        timestamp: Date.now(),
      });
      await sleep(150);
      unsubA();
      unsubB();
      return counts;
    } finally {
      probe.close();
      broadcaster.close();
    }
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({ a: 1, b: 0 });
  },
});
