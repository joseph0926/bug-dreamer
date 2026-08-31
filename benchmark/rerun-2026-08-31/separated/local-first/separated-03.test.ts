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

type ReceivedMessage = {
  type?: string;
  key?: string;
  senderId?: unknown;
  timestamp?: unknown;
};

defineScenario({
  id: 'every outgoing broadcast message carries senderId, a numeric timestamp and a valid type',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-LF-07 — separated invariant catalog, sourced from public type BroadcastMessage in lf/src/broadcast.ts:16-21 and code contract lf/src/broadcast.ts:117-124',
  },
  inputs: {
    broadcast: { type: 'model-replaced', key: 'sep03:profile' },
    observer: 'a second BroadcastChannel on firsttx:models capturing the raw message',
  },
  expected:
    'The observed message has type model-replaced, a non-empty string senderId, and a finite numeric timestamp.',
  act: async () => {
    const broadcaster = ModelBroadcaster.getInstance();
    (broadcaster as unknown as { channel?: { unref?: () => void } }).channel?.unref?.();
    const received: ReceivedMessage[] = [];
    const observer = new BroadcastChannel('firsttx:models');
    (observer as unknown as { unref?: () => void }).unref?.();
    observer.onmessage = (event: MessageEvent) => {
      received.push(event.data as ReceivedMessage);
    };
    const before = Date.now();
    broadcaster.broadcast({ type: 'model-replaced', key: 'sep03:profile' });
    const delivered = await waitFor(() => received.some((m) => m?.key === 'sep03:profile'));
    observer.close();
    const message = received.find((m) => m?.key === 'sep03:profile');
    return {
      delivered,
      type: message?.type,
      senderIdIsString: typeof message?.senderId === 'string' && message.senderId.length > 0,
      timestampIsFiniteNumber:
        typeof message?.timestamp === 'number' && Number.isFinite(message.timestamp),
      timestampNotBeforeSend:
        typeof message?.timestamp === 'number' && message.timestamp >= before,
    };
  },
  assert: (actual, expect) => {
    expect(actual.delivered).toBe(true);
    expect(actual.type).toBe('model-replaced');
    expect(actual.senderIdIsString).toBe(true);
    expect(actual.timestampIsFiniteNumber).toBe(true);
    expect(actual.timestampNotBeforeSend).toBe(true);
  },
});
