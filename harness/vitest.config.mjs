const moduleDir = process.env.BUG_DREAMER_MODULE_DIR;

export default {
  root: moduleDir,
  cacheDir: '/tmp/vite',
  resolve: {
    alias: {
      '@bug-dreamer/scenario': `${moduleDir}/.bug-dreamer/scenario.mjs`,
      '@target': `${moduleDir}/src`,
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
