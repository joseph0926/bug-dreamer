import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { signatureKey } from '../src/batch.mjs';
import { classifyRun } from '../src/classify.mjs';
import { DEFAULT_TIMEOUT_MS } from '../src/constants.mjs';
import { buildDockerRunArgs } from '../src/docker-command.mjs';
import { runCommand } from '../src/process.mjs';
import { inspectScenario } from '../src/scenario-file.mjs';
import { validateHistory } from '../src/v03-history.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildExactReplayArgs({ scenarioPath, containerName, image }) {
  return buildDockerRunArgs({
    scenarioPath,
    containerName,
    moduleDir: image.module,
    imageTag: image.imageId,
  });
}

export function classifyImageInspection(inspection) {
  if (inspection.exitCode === 0) return true;
  const diagnostic = `${inspection.stdout}\n${inspection.stderr}`;
  if (/No such image|No such object/i.test(diagnostic)) return false;
  throw new Error(`Docker image inspection failed: ${diagnostic.trim()}`);
}

function usage() {
  return 'Usage: node scripts/replay-v02-frozen.mjs (--entry <nightmare-id> | --all-available)';
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--all-available') return { allAvailable: true };
  if (args.length === 2 && args[0] === '--entry' && args[1].length > 0) {
    return { allAvailable: false, entryId: args[1] };
  }
  throw new TypeError(usage());
}

function readPointer(value, pointer) {
  let current = value;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) {
      throw new Error(`JSON pointer not found: ${pointer}`);
    }
    current = current[token];
  }
  return current;
}

function valuesForKey(value, key, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) valuesForKey(item, key, output);
    return output;
  }
  if (value === null || typeof value !== 'object') return output;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key) output.push(entryValue);
    valuesForKey(entryValue, key, output);
  }
  return output;
}

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), 'utf8'));
}

async function historicalSignature(record) {
  for (const reference of record.evidenceRefs) {
    const evidence = await json(reference.path);
    const node = readPointer(evidence, reference.jsonPointer);
    const signatures = valuesForKey(node, 'failure_signature').filter(Boolean);
    if (signatures.length > 0) return signatures[0];
  }
  throw new Error(`Historical failure signature is missing: ${record.id}`);
}

async function imageAvailable(imageId) {
  const inspection = await runCommand('docker', ['image', 'inspect', imageId]);
  try {
    return classifyImageInspection(inspection);
  } catch (error) {
    throw new Error(`${error.message} (${imageId})`);
  }
}

async function removeContainer(containerName) {
  await runCommand('docker', ['rm', '--force', containerName]);
}

async function replay(replayCase, image) {
  const replayKind = image.preservation.status === 'best-effort-rebuilt' ? 'best-effort-rebuilt' : 'exact-image-id';
  const executedImageId = replayKind === 'best-effort-rebuilt' ? image.archive.restoredImageId : image.imageId;
  if (!(await imageAvailable(executedImageId))) {
    return {
      id: replayCase.id,
      historicalImageId: image.imageId,
      executedImageId,
      replayKind,
      scenario: replayCase.scenario.path,
      status: 'unavailable',
    };
  }

  const scenario = await inspectScenario(path.join(repositoryRoot, replayCase.scenario.path));
  if (scenario.hash !== `sha256:${replayCase.scenario.sha256}`) {
    throw new Error(`Scenario hash mismatch before replay: ${replayCase.id}`);
  }
  const timeoutMatch = /--timeout-ms\s+(\d+)/.exec(replayCase.scenario.originalCommand);
  const timeoutMs = timeoutMatch === null ? DEFAULT_TIMEOUT_MS : Number(timeoutMatch[1]);
  const containerName = `bug-dreamer-v02-replay-${process.pid}-${randomUUID()}`;
  const dockerArgs = buildExactReplayArgs({
    scenarioPath: scenario.path,
    containerName,
    image: { ...image, imageId: executedImageId },
  });
  const result = await runCommand('docker', dockerArgs, {
    timeoutMs,
    onTimeout: () => removeContainer(containerName),
  });
  const classified = classifyRun(result);
  let signatureMatch;
  if (replayCase.expectedOutcome === 'candidate-failure') {
    const expectedSignature = await historicalSignature(replayCase);
    signatureMatch =
      classified.outcome === 'candidate-failure' &&
      signatureKey(classified.failureSignature) === signatureKey(expectedSignature);
  }
  const outcomeMatch = classified.outcome === replayCase.expectedOutcome;

  return {
    id: replayCase.id,
    historicalImageId: image.imageId,
    executedImageId,
    replayKind,
    scenario: replayCase.scenario.path,
    status: outcomeMatch && signatureMatch !== false ? 'pass' : 'mismatch',
    observedOutcome: classified.outcome,
    signatureMatch: signatureMatch ?? null,
    durationMs: result.durationMs,
  };
}

async function main() {
  let input;
  try {
    input = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  const audit = await json('history/v0.2-audit.json');
  const images = await json('history/v0.2-images.json');
  await validateHistory(repositoryRoot);
  const auditById = new Map(audit.records.map((record) => [record.id, record]));
  const replayCases = images.images.flatMap((image) =>
    image.replayCases.map((item) => {
      const replayCase = item.auditId === undefined ? item : auditById.get(item.auditId);
      if (replayCase === undefined) throw new Error(`Unknown replay audit entry: ${item.auditId}`);
      return {
        image,
        replayCase: {
          ...replayCase,
          expectedOutcome: replayCase.expectedOutcome ?? 'candidate-failure',
        },
      };
    }),
  );
  const selectedCases = input.allAvailable
    ? replayCases
    : replayCases.filter(({ replayCase }) => replayCase.id === input.entryId);

  if (selectedCases.length === 0) {
    process.stderr.write(`Unknown nightmare entry: ${input.entryId}\n`);
    process.exitCode = 2;
    return;
  }

  const results = [];
  for (const item of selectedCases) {
    try {
      results.push(await replay(item.replayCase, item.image));
    } catch (error) {
      const replayKind = item.image.preservation.status === 'best-effort-rebuilt' ? 'best-effort-rebuilt' : 'exact-image-id';
      results.push({
        id: item.replayCase.id,
        historicalImageId: item.image.imageId,
        executedImageId: replayKind === 'best-effort-rebuilt' ? item.image.archive.restoredImageId : item.image.imageId,
        replayKind,
        scenario: item.replayCase.scenario.path,
        status: 'error',
        errorMessage: error.message,
      });
    }
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 'bug-dreamer/v02-replay-result/v1', results }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
