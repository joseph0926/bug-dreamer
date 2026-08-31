export default {
  root: '/workspace/packages/tx',
  cacheDir: '/tmp/vite',
  resolve: {
    alias: {
      '@bug-dreamer/scenario': '/workspace/packages/tx/.bug-dreamer/scenario.mjs',
      '@target': '/workspace/packages/tx/src',
    },
  },
  server: {
    fs: {
      allow: ['/workspace'],
    },
  },
  test: {
    environment: 'node',
    fileParallelism: false,
    isolate: true,
    disableConsoleIntercept: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
};
