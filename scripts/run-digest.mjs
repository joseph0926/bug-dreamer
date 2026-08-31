import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderDigest } from '../src/digest.mjs';
import { DEFAULT_MODULE } from '../src/modules.mjs';
import { runCommand } from '../src/process.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runBatchScript = path.join(repositoryRoot, 'scripts', 'run-batch.mjs');

function parseArgs(args) {
  let dir;
  let moduleName = DEFAULT_MODULE;

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name}`);
    if (name === '--dir') dir = value;
    else if (name === '--module') moduleName = value;
    else throw new Error(`Unknown option: ${name}`);
  }

  if (dir === undefined) {
    throw new Error('Usage: node scripts/run-digest.mjs --dir <scenario-directory> [--module <module>]');
  }

  return { dir, moduleName };
}

async function main() {
  const { dir, moduleName } = parseArgs(process.argv.slice(2));
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
  if (batch.scenario_count > 20) {
    throw new Error('Batch exceeds the recorded budget of 20 scenarios');
  }

  const date = new Date().toISOString().slice(0, 10);
  const digestDirectory = path.join(repositoryRoot, 'digests');
  const digestPath = path.join(digestDirectory, `${date}.md`);
  await mkdir(digestDirectory, { recursive: true });
  await writeFile(digestPath, renderDigest(batch, date));
  process.stdout.write(`${JSON.stringify({ digest: path.relative(repositoryRoot, digestPath), candidates: batch.results.filter((r) => r.aggregate.reportable).length, scenarios: batch.scenario_count })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
