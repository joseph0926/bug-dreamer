import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'unsubscribed callback stops receiving while remaining subscriber of same key still fires',
  oracle: {
    basis: 'public-type',
    ref: 'src/broadcast.ts ModelBroadcaster.subscribe(key, callback): () => void - "Subscribe to model changes from other tabs", returned function unsubscribes',
  },
  inputs: {
    sequence:
      'two callbacks subscribe to key cart, first unsubscribes (twice, idempotent), external message arrives, then second unsubscribes and another message arrives',
  },
  expected:
    'After unsubscribing, callback A never fires; callback B fires exactly once for the message delivered while it was subscribed',
  act: async () => {
    const counts = { a: 0, b: 0 };
    const broadcaster = ModelBroadcaster.getInstance();
    const unsubA = broadcaster.subscribe('cart', () => {
      counts.a++;
    });
    const unsubB = broadcaster.subscribe('cart', () => {
      counts.b++;
    });
    unsubA();
    unsubA();
    const external = new BroadcastChannel('firsttx:models');
    const waitFor = async (cond: () => boolean) => {
      const start = Date.now();
      while (!cond() && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    external.postMessage({
      type: 'model-patched',
      key: 'cart',
      senderId: 'tab-b',
      timestamp: Date.now(),
    });
    await waitFor(() => counts.b >= 1);
    unsubB();
    external.postMessage({
      type: 'model-patched',
      key: 'cart',
      senderId: 'tab-b',
      timestamp: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 150));
    external.close();
    broadcaster.close();
    return counts;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({ a: 0, b: 1 });
  },
});
