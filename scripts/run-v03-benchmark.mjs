import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPhase4Registration } from '../src/v03-benchmark-contract.mjs';
import {
  validateActualPhase4BenchmarkReadiness,
} from '../src/v03-benchmark-validation.mjs';
import { canonicalJson } from '../src/v03-wire.mjs';

export const PHASE4_BENCHMARK_PATHS = Object.freeze({
  authorBundle: 'benchmark/v0.3/authoring/bundle.json',
  executionManifest: 'benchmark/v0.3/execution-manifest.json',
  epoch: 'benchmark/v0.3/epoch.json',
  preparationEvidence: 'evidence/v0.3/phase4-preparation.json',
  measurementEvidence: 'evidence/v0.3/phase4/measurement.json',
  score: 'benchmark/v0.3/results/score.json',
  runRecordPattern: 'evidence/v0.3/phase4/runs/000000.json',
});

export async function runV03BenchmarkCli(repositoryRoot) {
  const { registration } = await loadPhase4Registration(repositoryRoot);

  // This gate intentionally precedes author, epoch, preparation, evidence, output,
  // and Docker access. The checked-in approved-unsealed registration stops here.
  validateActualPhase4BenchmarkReadiness(registration);
  throw new Error('Phase 4 measurement execution wiring is incomplete: frozen seed bodies, operator selection records, and evidence writing must be connected before execution');
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    process.stderr.write('Usage: node scripts/run-v03-benchmark.mjs\n');
    process.exitCode = 2;
  } else {
    runV03BenchmarkCli(repositoryRoot).then((result) => {
      process.stdout.write(`${canonicalJson(result)}\n`);
    }).catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
