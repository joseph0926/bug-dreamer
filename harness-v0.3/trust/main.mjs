import { evaluateTrustedResult, writeTrustedResult } from '/consumer/evaluator/evaluator.mjs';

async function main() {
  await writeTrustedResult(await evaluateTrustedResult());
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
