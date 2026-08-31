import { defineScenario } from '@bug-dreamer/scenario';
import { ModelBroadcaster } from '@target/broadcast';

defineScenario({
  id: 'getInstance after close hands out a usable broadcaster whose broadcast never throws',
  oracle: {
    basis: 'documentation',
    ref: 'broadcast.ts FallbackChannel jsdoc: graceful degradation without crashes; getInstance() is the only way to obtain a broadcaster so it must return a working instance',
  },
  inputs: {
    sequence: 'getInstance(), close(), getInstance() again, then broadcast a model-patched message',
  },
  expected:
    'Broadcasting through an instance obtained after close() does not throw, because the singleton either reinitializes its channel or degrades to a no-op.',
  act: async () => {
    const first = ModelBroadcaster.getInstance();
    first.close();
    const second = ModelBroadcaster.getInstance();
    try {
      second.broadcast({ type: 'model-patched', key: 'profile' });
      return 'broadcast-ok';
    } catch (error) {
      return `broadcast-threw:${(error as Error).name}`;
    }
  },
  assert: (actual, expect) => {
    expect(actual).toBe('broadcast-ok');
  },
});
