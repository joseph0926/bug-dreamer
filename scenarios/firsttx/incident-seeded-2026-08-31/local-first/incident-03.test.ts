import { defineScenario } from '@bug-dreamer/scenario';
import { z } from 'zod';
import { Storage } from '@target/storage';
import { StorageManager } from '@target/storage-manager';

type StoredRow = { _v: number; updatedAt: number; data: number };

defineScenario({
  id: 'version-reset seeding must not persist or return initialData that violates the model schema',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/local-first/src/storage-manager.ts load() deletes stored data that fails schema.safeParse and raises ValidationError (errors.ts), and sync-manager.ts replace()/patch() validate before every save, including drafts built from initialData — declaring that no schema-invalid data is persisted or returned; the version-reset branch saves and returns initialData without validation',
  },
  inputs: {
    schema: 'z.number().max(10)',
    storedValidValue: 5,
    storedVersion: 1,
    modelVersion: 2,
    initialData: 99,
  },
  expected:
    'Loading after a version bump either seeds a schema-valid value or refuses the seed (null or ValidationError); any value load() returns satisfies the schema and the persisted row stays schema-valid.',
  act: async () => {
    const rows = new Map<string, StoredRow>();
    rows.set('capped-counter', { _v: 1, updatedAt: Date.now(), data: 5 });

    const stub = {
      async get(key: string): Promise<StoredRow | null> {
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
      const schema = z.number().max(10);
      const manager = new StorageManager<number>({
        name: 'capped-counter',
        schema,
        version: 2,
        ttl: 60_000,
        initialData: 99,
      });

      let returnedData: number | null = null;
      let loadOutcome = 'returned';
      try {
        const result = await manager.load();
        if (result === null) {
          loadOutcome = 'refused-null';
        } else {
          returnedData = result.data;
        }
      } catch (error) {
        loadOutcome = error instanceof Error ? error.name : 'unknown-error';
      }

      const persisted = rows.get('capped-counter') ?? null;

      return {
        loadOutcome,
        returnedSatisfiesSchema:
          returnedData === null ? null : schema.safeParse(returnedData).success,
        persistedSatisfiesSchema:
          persisted === null ? null : schema.safeParse(persisted.data).success,
      };
    } finally {
      Storage.setInstance(undefined);
    }
  },
  assert: (actual, expect) => {
    const observed = actual as {
      loadOutcome: string;
      returnedSatisfiesSchema: boolean | null;
      persistedSatisfiesSchema: boolean | null;
    };
    if (observed.loadOutcome === 'returned') {
      expect(observed.returnedSatisfiesSchema).toBe(true);
    }
    expect(
      observed.persistedSatisfiesSchema === null || observed.persistedSatisfiesSchema === true,
    ).toBe(true);
  },
});
