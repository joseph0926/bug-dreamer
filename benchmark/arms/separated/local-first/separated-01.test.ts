import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'broadcaster ignores messages carrying its own senderId but reacts to foreign ones',
  oracle: {
    basis: 'existing-test',
    ref: 'INV-LF-03 — test "should not reload cache for own messages" in packages/local-first/tests/broadcast.test.ts; code contract packages/local-first/src/broadcast.ts:139-141',
  },
  inputs: { key: 'own-message-key', channelName: 'firsttx:models' },
  expected:
    'A message whose senderId equals the local sender id triggers no subscriber callbacks, while the same message with a foreign senderId triggers exactly one callback.',
  act: async () => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const broadcaster = ModelBroadcaster.getInstance();
    const probe = new BroadcastChannel('firsttx:models');
    try {
      let callbackCount = 0;
      const unsubscribe = broadcaster.subscribe('own-message-key', () => {
        callbackCount++;
      });
      const capturedSenderId = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('capture-timed-out'), 2000);
        probe.onmessage = (event: MessageEvent) => {
          clearTimeout(timer);
          resolve((event.data as { senderId: string }).senderId);
        };
        broadcaster.broadcast({ type: 'model-patched', key: 'own-message-key' });
      });
      probe.postMessage({
        type: 'model-patched',
        key: 'own-message-key',
        senderId: capturedSenderId,
        timestamp: Date.now(),
      });
      await sleep(100);
      const afterOwnSenderId = callbackCount;
      probe.postMessage({
        type: 'model-patched',
        key: 'own-message-key',
        senderId: `foreign-${capturedSenderId}`,
        timestamp: Date.now(),
      });
      await sleep(100);
      const afterForeignSenderId = callbackCount;
      unsubscribe();
      return {
        senderIdCaptured: capturedSenderId !== 'capture-timed-out',
        afterOwnSenderId,
        afterForeignSenderId,
      };
    } finally {
      probe.close();
      broadcaster.close();
    }
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      senderIdCaptured: true,
      afterOwnSenderId: 0,
      afterForeignSenderId: 1,
    });
  },
});
