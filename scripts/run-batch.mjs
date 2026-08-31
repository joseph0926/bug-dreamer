import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregateRuns } from '../src/batch.mjs';
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from '../src/constants.mjs';
import { DEFAULT_MODULE, resolveModule } from '../src/modules.mjs';
import { runCommand } from '../src/process.mjs';
import { relativeScenarioPath } from '../src/scenario-file.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runScenarioScript = path.join(repositoryRoot, 'scripts', 'run-scenario.mjs');

function parseArgs(args) {
  let dir;
  let moduleName = DEFAULT_MODULE;
  let runs = 3;
  let timeoutMs;

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name}`);
    if (name === '--dir') dir = value;
    else if (name === '--module') moduleName = value;
    else if (name === '--runs') runs = Number(value);
    else if (name === '--timeout-ms') timeoutMs = Number(value);
    else throw new Error(`Unknown option: ${name}`);
  }

  if (dir === undefined) {
    throw new Error(
      'Usage: node scripts/run-batch.mjs --dir <scenario-directory> [--module <module>] [--runs <count>] [--timeout-ms <milliseconds>]',
    );
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
    throw new Error('Runs must be an integer between 1 and 10');
  }
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new Error(`Timeout must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }

  return { dir, module: resolveModule(moduleName), runs, timeoutMs };
}

function parseEvidence(result) {
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed?.evidence?.classification?.outcome === undefined) throw new Error('missing fields');
    return parsed.evidence;
  } catch {
    return {
      classification: {
        outcome: 'unrunnable',
        unrunnable_kind: 'infrastructure',
        rule: 'runner-output-parse-failure',
      },
      logs: {
        excerpt: `${result.stdout}${result.stderr}`.slice(0, 8192),
        truncated: result.truncated,
        full_ref: null,
      },
      human_verdict: 'unreviewed',
    };
  }
}

async function runScenarioOnce(scenarioPath, moduleName, timeoutMs) {
  const args = [runScenarioScript, '--scenario', scenarioPath, '--module', moduleName];
  if (timeoutMs !== undefined) args.push('--timeout-ms', String(timeoutMs));
  const result = await runCommand(process.execPath, args, { cwd: repositoryRoot });
  return parseEvidence(result);
}

async function main() {
  const { dir, module, runs, timeoutMs } = parseArgs(process.argv.slice(2));
  const directory = path.resolve(dir);
  const relativeDirectory = relativeScenarioPath(repositoryRoot, directory);
  const entries = await readdir(directory);
  const scenarios = entries.filter((entry) => entry.endsWith('.test.ts')).sort();

  if (scenarios.length === 0) {
    throw new Error(`No .test.ts scenarios found in ${relativeDirectory}`);
  }

  const results = [];
  for (const scenario of scenarios) {
    const scenarioPath = path.join(directory, scenario);
    const evidences = [];
    for (let attempt = 0; attempt < runs; attempt += 1) {
      evidences.push(await runScenarioOnce(scenarioPath, module.module, timeoutMs));
    }
    const aggregate = aggregateRuns(evidences);
    results.push({
      scenario,
      aggregate: {
        outcome: aggregate.outcome,
        signatures_match: aggregate.signaturesMatch,
        reportable: aggregate.reportable,
        rule: aggregate.rule,
      },
      runs: evidences,
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        batch: {
          scenario_directory: relativeDirectory,
          module: module.module,
          runs_per_scenario: runs,
          scenario_count: scenarios.length,
          results,
        },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
