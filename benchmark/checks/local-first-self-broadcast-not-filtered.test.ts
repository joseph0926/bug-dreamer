import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'ignores broadcast messages carrying its own sender id',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/local-first/src/broadcast.ts subscribe callbacks fire only for changes from other tabs',
  },
  inputs: {
    echoedSenderId: 'own',
  },
  expected: 'A message that echoes the local sender id triggers no local callbacks.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    const raw = new BroadcastChannel('firsttx:models');
    const senderIdReceived = new Promise<string>((resolve) => {
      raw.onmessage = (event) => resolve((event.data as { senderId: string }).senderId);
    });

    let selfDeliveries = 0;
    broadcaster.subscribe('probe', () => {
      selfDeliveries += 1;
    });

    broadcaster.broadcast({ type: 'model-patched', key: 'probe' });
    const senderId = await senderIdReceived;

    raw.postMessage({ type: 'model-patched', key: 'probe', senderId, timestamp: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 100));

    raw.close();
    broadcaster.close();
    return selfDeliveries;
  },
  assert: (actual, expect) => {
    expect(actual).toBe(0);
  },
});
