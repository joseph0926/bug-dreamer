import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitFor = async (cond: () => boolean, timeoutMs = 3000): Promise<boolean> => {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    await sleep(10);
  }
  return cond();
};

defineScenario({
  id: 'incoming message carrying the local senderId is ignored while a foreign senderId triggers subscribers',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-LF-03 — separated invariant catalog, sourced from lf/tests/broadcast.test.ts "should not reload cache for own messages" and code contract lf/src/broadcast.ts:139-141',
  },
  inputs: {
    key: 'sep01:user',
    messages: [
      'model-patched with senderId equal to the local broadcaster senderId',
      'model-patched with senderId "foreign-tab"',
    ],
  },
  expected:
    'The subscriber fires zero times for the message with the local senderId and exactly once for the foreign message.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    (broadcaster as unknown as { channel?: { unref?: () => void } }).channel?.unref?.();
    const localSenderId = (broadcaster as unknown as { senderId: string }).senderId;
    let calls = 0;
    const unsubscribe = broadcaster.subscribe('sep01:user', () => {
      calls += 1;
    });
    const peer = new BroadcastChannel('firsttx:models');
    (peer as unknown as { unref?: () => void }).unref?.();
    peer.postMessage({
      type: 'model-patched',
      key: 'sep01:user',
      senderId: localSenderId,
      timestamp: Date.now(),
    });
    await sleep(200);
    const callsAfterOwnSender = calls;
    peer.postMessage({
      type: 'model-patched',
      key: 'sep01:user',
      senderId: 'foreign-tab',
      timestamp: Date.now(),
    });
    const foreignDelivered = await waitFor(() => calls > 0);
    unsubscribe();
    peer.close();
    return { callsAfterOwnSender, foreignDelivered, totalCalls: calls };
  },
  assert: (actual, expect) => {
    expect(actual.callsAfterOwnSender).toBe(0);
    expect(actual.foreignDelivered).toBe(true);
    expect(actual.totalCalls).toBe(1);
  },
});
