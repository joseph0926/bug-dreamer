import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'subscriber unsubscribed by an earlier subscriber mid-dispatch does not receive that notification',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/local-first/src/cache-manager.ts subscribe(): the returned unsubscribe removes the callback so it must not be invoked afterwards, including within the notification that removed it',
  },
  inputs: { ttl: 60000, data: 1 },
  expected:
    'When subscriber A unsubscribes subscriber B while a notification is being dispatched, B is not called for that notification and only A remains registered afterwards.',
  act: async () => {
    const cache = new CacheManager<number>(60000);
    const calls: string[] = [];
    let unsubB: () => void = () => {};

    cache.subscribe(() => {
      calls.push('A');
      unsubB();
    });
    unsubB = cache.subscribe(() => {
      calls.push('B');
    });

    cache.updateWithData(1, Date.now());

    return { calls, remainingSubscribers: cache.getSubscriberCount() };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({ calls: ['A'], remainingSubscribers: 1 });
  },
});
