import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'cross-tab patch message notifies only subscribers of the matching model key',
  oracle: {
    basis: 'documentation',
    ref: 'broadcast.ts subscribe() jsdoc: subscribe to model changes from other tabs, callbacks are registered per model key',
  },
  inputs: {
    subscriptions: ['todos', 'settings'],
    externalMessage: { type: 'model-patched', key: 'todos', senderId: 'external-tab' },
  },
  expected:
    'A model-patched message posted by another tab on the firsttx:models channel invokes only the callbacks registered for that key.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    const hits: string[] = [];
    broadcaster.subscribe('todos', () => {
      hits.push('todos');
    });
    broadcaster.subscribe('settings', () => {
      hits.push('settings');
    });
    const otherTab = new BroadcastChannel('firsttx:models');
    otherTab.postMessage({
      type: 'model-patched',
      key: 'todos',
      senderId: 'external-tab',
      timestamp: Date.now(),
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    otherTab.close();
    broadcaster.close();
    return hits;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual(['todos']);
  },
});
