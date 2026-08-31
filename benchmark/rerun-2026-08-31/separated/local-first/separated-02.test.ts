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
  id: 'a broadcast for one model key never invokes subscribers of a different key',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-LF-04 — separated invariant catalog, sourced from lf/tests/broadcast.test.ts "should only reload affected model" and "should broadcast different keys independently"',
  },
  inputs: {
    subscriptions: ['sep02:alpha', 'sep02:beta'],
    message: 'foreign model-replaced for key sep02:alpha only',
  },
  expected:
    'The subscriber of sep02:alpha fires exactly once and the subscriber of sep02:beta fires zero times.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    (broadcaster as unknown as { channel?: { unref?: () => void } }).channel?.unref?.();
    let alphaCalls = 0;
    let betaCalls = 0;
    const unsubAlpha = broadcaster.subscribe('sep02:alpha', () => {
      alphaCalls += 1;
    });
    const unsubBeta = broadcaster.subscribe('sep02:beta', () => {
      betaCalls += 1;
    });
    const peer = new BroadcastChannel('firsttx:models');
    (peer as unknown as { unref?: () => void }).unref?.();
    peer.postMessage({
      type: 'model-replaced',
      key: 'sep02:alpha',
      senderId: 'foreign-tab',
      timestamp: Date.now(),
    });
    const delivered = await waitFor(() => alphaCalls > 0);
    await sleep(150);
    unsubAlpha();
    unsubBeta();
    peer.close();
    return { delivered, alphaCalls, betaCalls };
  },
  assert: (actual, expect) => {
    expect(actual.delivered).toBe(true);
    expect(actual.alphaCalls).toBe(1);
    expect(actual.betaCalls).toBe(0);
  },
});
