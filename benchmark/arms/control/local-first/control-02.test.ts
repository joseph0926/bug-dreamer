import { defineScenario } from '@bug-dreamer/scenario';
import { CacheManager } from '@target/cache-manager';

defineScenario({
  id: 'callback subscribed during an in-flight notification is not invoked for that same notification',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/local-first/src/cache-manager.ts subscribe(): a subscription only observes notifications emitted after subscribe returns, matching external-store subscription semantics',
  },
  inputs: { ttl: 60000, firstData: 1, secondData: 2 },
  expected:
    'A callback registered while updateWithData is dispatching receives no call from that in-flight dispatch and exactly one call from the next update.',
  act: async () => {
    const cache = new CacheManager<number>(60000);
    const calls: string[] = [];
    let registeredLate = false;

    cache.subscribe(() => {
      calls.push('A');
      if (!registeredLate) {
        registeredLate = true;
        cache.subscribe(() => {
          calls.push('late');
        });
      }
    });

    cache.updateWithData(1, Date.now());
    const afterFirstDispatch = [...calls];

    cache.updateWithData(2, Date.now());
    const afterSecondDispatch = [...calls];

    return { afterFirstDispatch, afterSecondDispatch };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      afterFirstDispatch: ['A'],
      afterSecondDispatch: ['A', 'A', 'late'],
    });
  },
});
