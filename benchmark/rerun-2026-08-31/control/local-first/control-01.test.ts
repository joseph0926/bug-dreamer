import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'messages from another tab notify only subscribers of the matching key including deletes',
  oracle: {
    basis: 'documentation',
    ref: 'packages/local-first/README.md "Multi-tab updates: BroadcastChannel notifies other tabs to reload the stored snapshot" and "Cross-Tab Synchronization: Tabs auto-reload from IndexedDB on receiving broadcast"; BroadcastMessage type in src/broadcast.ts includes model-deleted',
  },
  inputs: {
    subscribedKeys: ['cart', 'other'],
    externalMessages: ['model-patched key=cart', 'model-deleted key=cart'],
  },
  expected:
    'The cart subscriber fires once per received external message (patch and delete) and the other-key subscriber never fires',
  act: async () => {
    const events: string[] = [];
    const broadcaster = ModelBroadcaster.getInstance();
    broadcaster.subscribe('cart', () => {
      events.push('cart');
    });
    broadcaster.subscribe('other', () => {
      events.push('other');
    });
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
    await waitFor(() => events.length >= 1);
    external.postMessage({
      type: 'model-deleted',
      key: 'cart',
      senderId: 'tab-b',
      timestamp: Date.now(),
    });
    await waitFor(() => events.length >= 2);
    external.close();
    broadcaster.close();
    return events;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual(['cart', 'cart']);
  },
});
