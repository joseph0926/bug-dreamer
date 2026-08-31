import { IMAGE_TAG, RUN_LIMITS } from './constants.mjs';

export function buildDockerRunArgs({ scenarioPath, containerName }) {
  if (scenarioPath.includes(',')) {
    throw new Error('Scenario paths containing commas are not supported');
  }

  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '--pull',
    'never',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--cpus',
    RUN_LIMITS.cpus,
    '--memory',
    RUN_LIMITS.memory,
    '--memory-swap',
    RUN_LIMITS.memorySwap,
    '--pids-limit',
    RUN_LIMITS.pids,
    '--tmpfs',
    `/tmp:rw,nosuid,nodev,noexec,size=${RUN_LIMITS.tmpfs},mode=1777`,
    '--tmpfs',
    `/workspace/packages/tx/node_modules/.vite-temp:rw,nosuid,nodev,noexec,size=${RUN_LIMITS.viteTmpfs},mode=700,uid=1000,gid=1000`,
    '--user',
    '1000:1000',
    '--env',
    'HOME=/tmp/home',
    '--env',
    'XDG_CACHE_HOME=/tmp/cache',
    '--env',
    'NO_COLOR=1',
    '--mount',
    `type=bind,source=${scenarioPath},target=/workspace/packages/tx/.bug-dreamer/generated.test.ts,readonly`,
    IMAGE_TAG,
  ];
}
