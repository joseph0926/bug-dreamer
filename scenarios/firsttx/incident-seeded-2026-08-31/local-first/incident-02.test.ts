import { defineScenario } from '@bug-dreamer/scenario';
import { z } from 'zod';
import { Storage } from '@target/storage';
import { StorageManager } from '@target/storage-manager';
import { CacheManager } from '@target/cache-manager';
import { SyncManager } from '@target/sync-manager';

type StoredRow = { _v: number; updatedAt: number; data: string };

defineScenario({
  id: 'user replace completing while the initial storage load is in flight must not be reverted by the older loaded value',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/local-first/src/sync-manager.ts replace() drops a background replace whose expectedMutationVersion is outdated, declaring that a user mutation must not be overwritten by an older concurrent async result; executeSyncPromise applies the initial load result to the cache without that guard',
  },
  inputs: { storedValue: 'old', storedUpdatedAt: 1000, replacedValue: 'new' },
  expected:
    'After replace("new") resolves, the cached snapshot and the pending getSyncPromise result reflect "new"; the storage row read before the replace never rolls the cache back to "old".',
  act: async () => {
    const rows = new Map<string, StoredRow>();
    rows.set('incident-model', { _v: 1, updatedAt: 1000, data: 'old' });

    let releaseFirstGet: (value: StoredRow | null) => void = () => {};
    let firstGetSeen: () => void = () => {};
    const firstGetCalled = new Promise<void>((resolve) => {
      firstGetSeen = resolve;
    });
    let getCalls = 0;

    const stub = {
      async get(key: string): Promise<StoredRow | null> {
        getCalls += 1;
        if (getCalls === 1) {
          firstGetSeen();
          return new Promise<StoredRow | null>((resolve) => {
            releaseFirstGet = resolve;
          });
        }
        return rows.get(key) ?? null;
      },
      async set(key: string, value: StoredRow): Promise<void> {
        rows.set(key, value);
      },
      async delete(key: string): Promise<void> {
        rows.delete(key);
      },
    };
    Storage.setInstance(stub as unknown as Storage);

    try {
      const cache = new CacheManager<string>(60_000);
      const storage = new StorageManager<string>({
        name: 'incident-model',
        schema: z.string(),
        ttl: 60_000,
      });
      const sync = new SyncManager<string>(
        'incident-model',
        cache,
        storage,
        (_current, incoming) => incoming,
      );

      const syncPromise = sync.getSyncPromise(async () => 'fetched', {
        revalidateOnMount: 'never',
      });
      await firstGetCalled;

      await sync.replace('new');
      const cachedAfterReplace = cache.getCachedSnapshot();

      releaseFirstGet({ _v: 1, updatedAt: 1000, data: 'old' });
      const syncResult = await syncPromise;

      return {
        cachedAfterReplace,
        syncResult,
        cachedAfterLoadApplied: cache.getCachedSnapshot(),
        historyUpdatedAtAfterLoadApplied: cache.getCachedHistory().updatedAt,
      };
    } finally {
      Storage.setInstance(undefined);
    }
  },
  assert: (actual, expect) => {
    const observed = actual as {
      cachedAfterReplace: string | null;
      syncResult: string;
      cachedAfterLoadApplied: string | null;
    };
    expect(observed.cachedAfterReplace).toBe('new');
    expect(observed.syncResult).toBe('new');
    expect(observed.cachedAfterLoadApplied).toBe('new');
  },
});
