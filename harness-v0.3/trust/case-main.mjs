import { writeFile } from 'node:fs/promises';

import { evaluateTrustedResult, resultPath, writeTrustedResult } from '/consumer/evaluator/evaluator.mjs';

const CASE_MODES = ['missing', 'malformed', 'wrong-digest', 'early-exit', 'timeout', 'log-overflow'];

function holdForever() {
  return new Promise((resolve) => {
    setTimeout(resolve, 2147483647);
  });
}

function parseMode(args) {
  if (args.length !== 2 || args[0] !== '--mode' || !CASE_MODES.includes(args[1])) {
    throw new Error(`Usage: node /consumer/evaluator/case-main.mjs --mode <${CASE_MODES.join('|')}>`);
  }
  return args[1];
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const result = await evaluateTrustedResult();
  if (mode === 'missing') {
    process.stdout.write('BUG_DREAMER_RESULT {"execution":"candidate-failure"}\n');
    return;
  }
  if (mode === 'malformed') {
    process.stderr.write('BUG_DREAMER_RESULT {"execution":"candidate-failure"}\n');
    await writeFile(resultPath, '{"schemaVersion":');
    return;
  }
  if (mode === 'wrong-digest') {
    result.payloadDigest = '0'.repeat(64);
    await writeTrustedResult(result);
    return;
  }
  if (mode === 'timeout') {
    await writeTrustedResult(result);
    await holdForever();
  }
  if (mode === 'log-overflow') {
    await writeTrustedResult(result);
    const filler = `${'x'.repeat(65535)}\n`;
    for (let index = 0; index < 32; index += 1) process.stdout.write(filler);
    await holdForever();
  }
  process.stderr.write('BUG_DREAMER_RESULT {"execution":"candidate-failure"}\n');
  process.exitCode = 17;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
