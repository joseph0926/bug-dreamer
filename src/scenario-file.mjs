import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_SCENARIO_BYTES = 262_144;

export async function inspectScenario(inputPath) {
  const resolvedPath = path.resolve(inputPath);
  const baseName = path.basename(resolvedPath);

  if (/^\.env(?:\.|$)/u.test(baseName)) {
    throw new Error('Environment files cannot be used as scenarios');
  }
  if (!baseName.endsWith('.test.ts')) {
    throw new Error('Scenario path must end with .test.ts');
  }

  const initialStat = await lstat(resolvedPath);
  if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
    throw new Error('Scenario must be a regular file, not a symbolic link');
  }
  if (initialStat.size === 0 || initialStat.size > MAX_SCENARIO_BYTES) {
    throw new Error(`Scenario size must be between 1 and ${MAX_SCENARIO_BYTES} bytes`);
  }

  const canonicalPath = await realpath(resolvedPath);
  const content = await readFile(canonicalPath);

  return {
    path: canonicalPath,
    name: baseName,
    hash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
}

export function relativeScenarioPath(repositoryRoot, scenarioPath) {
  const relativePath = path.relative(repositoryRoot, scenarioPath);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('Scenario must be stored inside the Bug Dreamer repository');
  }
  return relativePath;
}
