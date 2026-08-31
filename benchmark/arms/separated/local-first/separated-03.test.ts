import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'every outgoing broadcast message carries senderId, timestamp, and a known type',
  oracle: {
    basis: 'public-type',
    ref: 'INV-LF-07 — public type BroadcastMessage in packages/local-first/src/broadcast.ts:16-21; code contract packages/local-first/src/broadcast.ts:117-124',
  },
  inputs: { type: 'model-replaced', key: 'shape-check' },
  expected:
    'An outgoing broadcast carries a string senderId, a numeric timestamp, the original key, and a type from the model-patched, model-replaced, model-deleted union.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    const probe = new BroadcastChannel('firsttx:models');
    try {
      const received = await new Promise<Record<string, unknown> | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 2000);
        probe.onmessage = (event: MessageEvent) => {
          clearTimeout(timer);
          resolve(event.data as Record<string, unknown>);
        };
        broadcaster.broadcast({ type: 'model-replaced', key: 'shape-check' });
      });
      if (!received) {
        return { received: false };
      }
      return {
        received: true,
        type: received.type,
        key: received.key,
        senderIdType: typeof received.senderId,
        timestampType: typeof received.timestamp,
        typeIsKnown: ['model-patched', 'model-replaced', 'model-deleted'].includes(
          received.type as string,
        ),
      };
    } finally {
      probe.close();
      broadcaster.close();
    }
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      received: true,
      type: 'model-replaced',
      key: 'shape-check',
      senderIdType: 'string',
      timestampType: 'number',
      typeIsKnown: true,
    });
  },
});
