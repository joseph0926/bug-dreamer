import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertDigestBudget, renderDigest } from '../src/digest.mjs';
import { DEFAULT_MODULE } from '../src/modules.mjs';
import { runCommand } from '../src/process.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runBatchScript = path.join(repositoryRoot, 'scripts', 'run-batch.mjs');

function parseArgs(args) {
  let dir;
  let moduleName = DEFAULT_MODULE;
  let modelCalls;

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name}`);
    if (name === '--dir') dir = value;
    else if (name === '--module') moduleName = value;
    else if (name === '--model-calls') modelCalls = Number(value);
    else throw new Error(`Unknown option: ${name}`);
  }

  if (dir === undefined) {
    throw new Error(
      'Usage: node scripts/run-digest.mjs --dir <scenario-directory> [--module <module>] [--model-calls <count>]',
    );
  }
  if (modelCalls !== undefined && (!Number.isInteger(modelCalls) || modelCalls < 0)) {
    throw new Error('Model calls must be a non-negative integer');
  }

  return { dir, moduleName, modelCalls };
}

async function main() {
  const { dir, moduleName, modelCalls } = parseArgs(process.argv.slice(2));

  const entries = await readdir(path.resolve(dir));
  const scenarioCount = entries.filter((entry) => entry.endsWith('.test.ts')).length;
  assertDigestBudget(scenarioCount);

  const batchRun = await runCommand(process.execPath, [
    runBatchScript,
    '--dir',
    dir,
    '--module',
    moduleName,
  ], { cwd: repositoryRoot });

  if (batchRun.exitCode !== 0) {
    throw new Error(`Batch failed: ${batchRun.stderr.trim()}`);
  }

  const { batch } = JSON.parse(batchRun.stdout);
  assertDigestBudget(batch.scenario_count);

  const date = new Date().toISOString().slice(0, 10);
  const evidenceDirectory = path.join(repositoryRoot, 'evidence', date);
  const evidencePath = path.join(evidenceDirectory, 'digest-batch.json');
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(evidencePath, batchRun.stdout);
  const evidenceRef = path.relative(repositoryRoot, evidencePath);

  const digestDirectory = path.join(repositoryRoot, 'digests');
  const digestPath = path.join(digestDirectory, `${date}.md`);
  await mkdir(digestDirectory, { recursive: true });
  await writeFile(digestPath, renderDigest(batch, date, { evidenceRef, modelCalls }));
  process.stdout.write(
    `${JSON.stringify({
      digest: path.relative(repositoryRoot, digestPath),
      evidence: evidenceRef,
      candidates: batch.results.filter((r) => r.aggregate.reportable).length,
      scenarios: batch.scenario_count,
      duration_ms: batch.execution?.duration_ms,
      model_calls: modelCalls ?? null,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
