import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HistoryValidationError, validateHistory } from '../src/v03-history.mjs';
import { ContractValidationError, validateContracts } from '../src/v03-contracts.mjs';
import { SpecValidationError, validateSpecContracts } from '../src/v03-spec-validation.mjs';
import { TrustValidationError, validateTrustContracts } from '../src/v03-trust-validation.mjs';
import { OperatorValidationError, validateOperatorContracts } from '../src/v03-operators-validation.mjs';
import { ReplayValidationError, validateSpikeReplay } from '../src/v03-replay-validation.mjs';
import { V03BenchmarkValidationError, validateActualPhase4Benchmark } from '../src/v03-benchmark-validation.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBCOMMANDS = new Set([
  'history',
  'contracts',
  'spec',
  'trust',
  'operators',
  'replay',
  'benchmark',
  'evidence',
  'reports',
  'all',
]);

function usage() {
  return 'Usage: node scripts/validate-v03.mjs <history|contracts|spec|trust|operators|replay|benchmark|evidence|reports|all> [--replay-available for history]';
}

function parseArgs(args) {
  const [subcommand, ...options] = args;
  if (!SUBCOMMANDS.has(subcommand)) throw new TypeError(usage());
  if (subcommand !== 'history') {
    if (options.length > 0) throw new TypeError(usage());
    return { subcommand, replayAvailable: false };
  }
  if (options.length === 0) return { subcommand, replayAvailable: false };
  if (options.length === 1 && options[0] === '--replay-available') {
    return { subcommand, replayAvailable: true };
  }
  throw new TypeError(usage());
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

  const validators = {
    history: () => validateHistory(repositoryRoot, input),
    contracts: () => validateContracts(repositoryRoot),
    spec: () => validateSpecContracts(repositoryRoot),
    trust: () => validateTrustContracts(repositoryRoot),
    operators: () => validateOperatorContracts(repositoryRoot),
    replay: () => validateSpikeReplay(repositoryRoot),
    benchmark: () => validateActualPhase4Benchmark(repositoryRoot),
  };
  if (validators[input.subcommand] === undefined) {
    process.stderr.write(`${input.subcommand} validation is not implemented yet\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await validators[input.subcommand]();
    process.stdout.write(`${JSON.stringify({ status: 'ok', subcommand: input.subcommand, ...result })}\n`);
  } catch (error) {
    const expected = error instanceof HistoryValidationError
      || error instanceof ContractValidationError
      || error instanceof SpecValidationError
      || error instanceof TrustValidationError
      || error instanceof OperatorValidationError
      || error instanceof ReplayValidationError
      || error instanceof V03BenchmarkValidationError;
    const message = expected ? error.message : `Unexpected validation error: ${error.message}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

main();
