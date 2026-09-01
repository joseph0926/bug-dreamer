import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HistoryValidationError, validateHistory } from '../src/v03-history.mjs';

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
  return 'Usage: node scripts/validate-v03.mjs history [--replay-available]';
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

  if (input.subcommand !== 'history') {
    process.stderr.write(`${input.subcommand} validation is not implemented yet\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await validateHistory(repositoryRoot, input);
    process.stdout.write(`${JSON.stringify({ status: 'ok', subcommand: 'history', ...result })}\n`);
  } catch (error) {
    const message = error instanceof HistoryValidationError ? error.message : `Unexpected validation error: ${error.message}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

main();
