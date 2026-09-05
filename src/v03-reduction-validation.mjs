import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { loadPhase3Catalog } from './v03-operators.mjs';
import { resolveContainedPath } from './v03-paths.mjs';
import { RULE_ORDER, ReductionError, reduceSpec } from './v03-reduction.mjs';
import { EXECUTION_BUDGET } from './v03-trust.mjs';
import { canonicalJson, domainDigest, parseJsonBytes } from './v03-wire.mjs';

export const REDUCTION_EVIDENCE_PATH = 'evidence/v0.3/phase3-reduction.json';
export const REDUCTION_REGISTRATION_PATH = 'benchmark/v0.3/phase3-reduction.json';
export const REDUCTION_COMMAND = 'node scripts/prepare-v03-reduction.mjs';
export const REDUCTION_ISOLATION_ARGS = Object.freeze([
  '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m',
  '--memory-swap', '512m', '--cpus', '1', '--user', '1000:1000',
  '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
]);
const SOURCE_PATHS = [
  'scripts/prepare-v03-reduction.mjs', 'src/v03-reduction.mjs',
  'src/v03-reduction-validation.mjs', 'src/v03-runner.mjs', 'src/v03-run-record.mjs',
];
const SPIKE_PATH = 'evidence/v0.3/phase3-spike.json';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function assert(condition, message) {
  if (!condition) throw new ReductionError(message);
}

export async function loadReductionContext(repositoryRoot) {
  const read = (relativePath) => readFile(resolveContainedPath(repositoryRoot, relativePath));
  const [registrationBytes, spikeBytes, { catalog: cleanCatalog, operatorCatalog }] = await Promise.all([
    read(REDUCTION_REGISTRATION_PATH), read(SPIKE_PATH), loadPhase3Catalog(repositoryRoot),
  ]);
  const registration = parseJsonBytes(registrationBytes);
  const expectedRegistration = {
    schemaVersion: 'bug-dreamer/phase3-reduction-registration/v1', registeredOn: '2026-09-05',
    spikeEvidencePath: SPIKE_PATH, ruleVersion: 'dependency-closure/v1', ruleOrder: RULE_ORDER,
    restartAfterAcceptedRemoval: true, argumentReduction: false,
    maxCandidateAttempts: 96, maxEvaluations: 64, replayRuns: 5, platform: 'linux/arm64',
  };
  assert(canonicalJson(registration) === canonicalJson(expectedRegistration), 'Reduction registration changed');
  const spike = parseJsonBytes(spikeBytes);
  assert(spike.verdict === 'adopt', 'Reduction requires an adopted spike');
  const arm = spike.arms.find((item) => item.operatorId === spike.adoptedOperatorId);
  assert(arm?.twoSided === true && arm.fiveOfFive === true, 'Reduction arm has not passed spike gates');
  const [seedBytes, requestBytes, sources] = await Promise.all([
    read(spike.seed.path), read(arm.requestPath),
    Promise.all(SOURCE_PATHS.map(async (sourcePath) => ({ path: sourcePath, sha256: sha256(await read(sourcePath)) }))),
  ]);
  assert(sha256(seedBytes) === spike.seed.sha256 && sha256(requestBytes) === arm.requestSha256, 'Reduction input differs from the adopted spike');
  const defectCatalog = { ...cleanCatalog, target: { ...cleanCatalog.target, artifactSha256: spike.defectArtifactDigest } };
  const trustBytes = await read(spike.phase2TrustEvidence.path);
  const trust = parseJsonBytes(trustBytes);
  const images = Object.fromEntries(['clean', 'defect'].map((artifact) => [artifact, {
    imageId: spike.images[`${artifact}Spike`].imageId,
    baseImageId: spike.images[`${artifact}Trust`].imageId,
    spikeContractKey: spike.spikeContractKeys[artifact],
    evaluationContractKey: artifact === 'clean' ? trust.evaluationContractKey : spike.defectEvaluationContractKey,
  }]));
  const bindings = {
    registration: { path: REDUCTION_REGISTRATION_PATH, sha256: sha256(registrationBytes) },
    spike: { path: SPIKE_PATH, sha256: sha256(spikeBytes) },
    seed: { path: spike.seed.path, sha256: sha256(seedBytes) },
    request: { path: arm.requestPath, sha256: sha256(requestBytes) },
    sources, images, platform: registration.platform, executionBudget: EXECUTION_BUDGET,
    dockerRunArgs: ['run', '--rm', '--name', '<container-name>', ...REDUCTION_ISOLATION_ARGS,
      '--mount', '<input-mount>', '--mount', '<result-mount>', '<image>', '/consumer/evaluator/main.mjs'],
  };
  return {
    registration, bindings, images, cleanCatalog, defectCatalog, operatorCatalog,
    input: { seed: parseJsonBytes(seedBytes), request: parseJsonBytes(requestBytes) },
    expectedIdentity: arm.defectRun.classification.violationIdentity,
    contractKey: domainDigest('bug-dreamer/reduction-contract/v1', bindings),
  };
}

export async function validateReductionReceipt(context, evidence) {
  assert(canonicalJson(Object.keys(evidence).sort()) === canonicalJson(['bindings', 'contractKey', 'replayCommand', 'result', 'schemaVersion']), 'Reduction evidence fields changed');
  assert(evidence.schemaVersion === 'bug-dreamer/phase3-reduction-evidence/v1', 'Reduction evidence schemaVersion changed');
  assert(canonicalJson(evidence.bindings) === canonicalJson(context.bindings), 'Reduction evidence bindings changed');
  assert(evidence.contractKey === context.contractKey, 'Reduction contract key mismatch');
  assert(evidence.replayCommand === REDUCTION_COMMAND, 'Reduction replay command changed');
  assert(evidence.result.status === 'one-minimal', 'Reduction did not reach one-minimal');
  const result = await reduceSpec({
    ...context,
    evaluate: async ({ index, phase, artifact, specDigest, planDigest }) => {
      const run = evidence.result.runs[index];
      assert(run !== undefined, `Reduction run missing: ${index}`);
      assert(run.index === index && run.phase === phase && run.artifact === artifact
        && run.specDigest === specDigest && run.planDigest === planDigest, `Reduction run binding mismatch: ${index}`);
      return run.record;
    },
  });
  assert(canonicalJson(result) === canonicalJson(evidence.result), 'Reduction trace differs from deterministic replay');
  assert(result.status === 'one-minimal', 'Reduction replay did not preserve the violation');
  return {
    status: result.status, specDigest: result.final.specDigest,
    actionCount: result.final.spec.transformedActions.length,
    acceptedRemovals: result.counts.acceptedRemovals,
    evaluations: result.counts.evaluations,
  };
}

export async function validateReductionEvidence(repositoryRoot) {
  const [context, bytes] = await Promise.all([
    loadReductionContext(repositoryRoot), readFile(resolveContainedPath(repositoryRoot, REDUCTION_EVIDENCE_PATH)),
  ]);
  return validateReductionReceipt(context, parseJsonBytes(bytes));
}
