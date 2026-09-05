#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { materializeAuthoringContext } from '../src/v03-benchmark-authoring.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: node scripts/prepare-v03-authoring.mjs --arm <G|P> --target <firsttx checkout> --out <new external directory>\n');
  process.exitCode = 2;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--arm', '--target', '--out'].includes(flag) || value === undefined) return null;
    values[flag] = value;
  }
  if (Object.keys(values).length !== 3 || !['G', 'P'].includes(values['--arm'])) return null;
  return { armId: values['--arm'], targetRoot: path.resolve(values['--target']), outputRoot: path.resolve(values['--out']) };
}

const args = parseArgs(process.argv.slice(2));
if (args === null) usage();
else {
  try {
    const result = await materializeAuthoringContext({ repositoryRoot, ...args });
    process.stdout.write(`${JSON.stringify(result.manifest)}\n`);
  } catch (error) {
    process.stderr.write(`Phase 4 authoring context preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
