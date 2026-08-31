export const TARGET_PROJECT = 'https://github.com/joseph0926/firsttx';
export const TARGET_REVISION = 'f624b09f148c3368a51807f48d3237db20cef9c6';
export const EVENT_PREFIX = 'BUG_DREAMER_EVENT ';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 30_000;
export const MAX_LOG_LENGTH = 262_144;
export const RUN_LIMITS = Object.freeze({
  cpus: '1',
  memory: '512m',
  memorySwap: '512m',
  pids: '64',
  tmpfs: '128m',
  viteTmpfs: '16m',
});
export const ORACLE_BASES = Object.freeze([
  'documentation',
  'existing-test',
  'public-type',
  'declared-invariant',
]);
