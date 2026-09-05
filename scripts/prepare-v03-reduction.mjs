import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { validateContracts } from '../src/v03-contracts.mjs';
import { validateOperatorContracts } from '../src/v03-operators-validation.mjs';
import { reduceSpec } from '../src/v03-reduction.mjs';
import {
  REDUCTION_COMMAND, REDUCTION_EVIDENCE_PATH, REDUCTION_ISOLATION_ARGS,
  loadReductionContext, validateReductionReceipt,
} from '../src/v03-reduction-validation.mjs';
import { validateSpikeEvidence } from '../src/v03-replay-validation.mjs';
import { createCaseRunner } from '../src/v03-runner.mjs';
import { validateTrustContracts } from '../src/v03-trust-validation.mjs';
import { EXECUTION_BUDGET, classifyTrustedResult, readTrustedResultChannel } from '../src/v03-trust.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const runCase = createCaseRunner({ spawn, budget: EXECUTION_BUDGET });

async function checkImage(image, platform) {
  const format = '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"labels":{{json .Config.Labels}}}';
  const { stdout } = await execFileAsync('docker', ['image', 'inspect', image.imageId, '--format', format], { timeout: 10000 });
  const actual = JSON.parse(stdout);
  if (actual.id !== image.imageId || `${actual.os}/${actual.architecture}` !== platform
    || actual.labels['org.bug-dreamer.base-image-id'] !== image.baseImageId
    || actual.labels['org.bug-dreamer.spike-contract-key'] !== image.spikeContractKey
    || actual.labels['org.bug-dreamer.evaluation-contract-key'] !== image.evaluationContractKey) {
    throw new Error('Reduction evaluator identity, platform, or contract mismatch');
  }
}

async function main() {
  if (process.argv.length !== 2) throw new TypeError(`Usage: ${REDUCTION_COMMAND}`);
  await validateContracts(repositoryRoot);
  await validateTrustContracts(repositoryRoot);
  await validateOperatorContracts(repositoryRoot);
  await validateSpikeEvidence(repositoryRoot);
  const context = await loadReductionContext(repositoryRoot);
  for (const image of Object.values(context.images)) await checkImage(image, context.registration.platform);
  const root = await mkdtemp(path.join(tmpdir(), 'bug-dreamer-v03-reduction-'));
  let result;
  try {
    result = await reduceSpec({
      ...context,
      evaluate: async ({ index, phase, artifact, spec, plan, catalog }) => {
        const inputDirectory = path.join(root, `run-${index}`, 'input');
        const resultDirectory = path.join(root, `run-${index}`, 'result');
        if (inputDirectory.includes(',')) throw new Error('Reduction mount path contains a comma');
        await mkdir(inputDirectory, { recursive: true });
        await mkdir(resultDirectory, { recursive: true });
        await chmod(resultDirectory, 0o777);
        await writeFile(path.join(inputDirectory, 'spec.json'), JSON.stringify(spec));
        await writeFile(path.join(inputDirectory, 'plan.json'), JSON.stringify(plan));
        const containerName = `bug-dreamer-v03-reduction-${randomUUID()}`;
        const args = ['run', '--rm', '--name', containerName, ...REDUCTION_ISOLATION_ARGS,
          '--mount', `type=bind,source=${inputDirectory},target=/input,readonly`,
          '--mount', `type=bind,source=${resultDirectory},target=/result`,
          context.images[artifact].imageId, '/consumer/evaluator/main.mjs'];
        const execution = await runCase(args, containerName);
        const { entries: resultEntries, resultBytes } = await readTrustedResultChannel(resultDirectory);
        const classification = classifyTrustedResult({ ...execution, resultBytes, plan, spec, catalog });
        process.stderr.write(`${phase} ${index}: ${classification.execution.status}\n`);
        return { ...execution, resultEntries, rawResult: resultBytes === null ? null : resultBytes.toString('utf8'), classification };
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const evidence = {
    schemaVersion: 'bug-dreamer/phase3-reduction-evidence/v1', bindings: context.bindings,
    contractKey: context.contractKey, replayCommand: REDUCTION_COMMAND, result,
  };
  if (result.status === 'one-minimal') await validateReductionReceipt(context, evidence);
  await writeFile(path.join(repositoryRoot, REDUCTION_EVIDENCE_PATH), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: result.status, blocker: result.blocker, evidence: REDUCTION_EVIDENCE_PATH, ...result.counts })}\n`);
  if (result.status !== 'one-minimal') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = error instanceof TypeError ? 2 : 1;
});
