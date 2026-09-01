import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildTransformedSpec, loadPhase3Catalog } from './v03-operators.mjs';
import {
  V03SpecError,
  buildExecutionPlan,
  buildNightmareSpec,
  parseNightmareSeed,
  planDigest,
  specDigest,
} from './v03-spec.mjs';
import { EXECUTION_BUDGET, classifyTrustedResult } from './v03-trust.mjs';
import { canonicalJson, domainDigest, parseJsonBytes } from './v03-wire.mjs';

const EVIDENCE_PATH = 'evidence/v0.3/phase3-spike.json';
const REGISTRATION_PATH = 'benchmark/v0.3/phase3-spike.json';
const MANIFEST_PATH = 'benchmark/manifest.json';
const SPEC_CASES_PATH = 'contracts/v0.3/spec-cases.json';
const HARNESS_FILES = ['harness-v0.3/trust/case-main.mjs', 'harness-v0.3/trust/evaluator.mjs', 'harness-v0.3/trust/main.mjs', 'harness-v0.3/trust/virtual-clock.mjs'];
const SOURCE_FILES = ['src/v03-wire.mjs', 'src/v03-spec.mjs', 'src/v03-trust.mjs'];
const OPERATOR_ARM_REQUESTS = [
  { operatorId: 'time.advance/v1', requestPath: 'contracts/v0.3/requests/time-advance.json' },
  { operatorId: 'schedule.release-order/v1', requestPath: 'contracts/v0.3/requests/spike-release-order.json' },
  { operatorId: 'fault.step-outcome/v1', requestPath: 'contracts/v0.3/requests/spike-fault.json' },
];

export class ReplayValidationError extends Error {}

function fail(message) {
  throw new ReplayValidationError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validImageId(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function rejectionRecord(error) {
  if (error instanceof V03SpecError) return { kind: error.kind, message: error.message };
  throw error;
}

function applyEdit(source, edit) {
  const occurrences = source.split(edit.find).length - 1;
  assert(occurrences === 1, `Recorded edit for ${edit.file} matched ${occurrences} times; exactly one match is required`);
  return source.replace(edit.find, edit.replace);
}

async function aggregateFiles(repositoryRoot, relativePaths) {
  const digest = createHash('sha256');
  for (const relativePath of [...relativePaths].sort()) {
    digest.update(relativePath);
    digest.update('\0');
    digest.update(await readFile(path.join(repositoryRoot, relativePath)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function recomputeRun(recorded, plan, spec, catalog, label) {
  const resultBytes = recorded.rawResult === null ? null : Buffer.from(recorded.rawResult, 'utf8');
  const classification = classifyTrustedResult({
    resultBytes,
    exitCode: recorded.exitCode,
    timedOut: recorded.timedOut,
    outputTruncated: recorded.outputTruncated,
    plan,
    spec,
    catalog,
  });
  assert(canonicalJson(classification) === canonicalJson(recorded.classification), `Spike run classification mismatch: ${label}`);
  return classification;
}

export async function validateSpikeReplay(repositoryRoot) {
  const readRepoFile = (relativePath) => readFile(path.join(repositoryRoot, relativePath));
  const [evidenceBytes, registrationBytes, manifestBytes, { catalog: cleanCatalog, catalogBytes, operatorCatalog, operatorBytes }] = await Promise.all([
    readRepoFile(EVIDENCE_PATH),
    readRepoFile(REGISTRATION_PATH),
    readRepoFile(MANIFEST_PATH),
    loadPhase3Catalog(repositoryRoot),
  ]);
  const evidence = parseJsonBytes(evidenceBytes);
  const registration = JSON.parse(registrationBytes.toString('utf8'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));

  assert(evidence.schemaVersion === 'bug-dreamer/phase3-spike-evidence/v1', 'Unexpected spike evidence schemaVersion');
  assert(evidence.registration.path === REGISTRATION_PATH && evidence.registration.sha256 === sha256(registrationBytes), 'Spike registration digest mismatch');
  assert(evidence.manifestDefect.path === MANIFEST_PATH && evidence.manifestDefect.sha256 === sha256(manifestBytes), 'Spike manifest digest mismatch');
  assert(evidence.manifestDefect.defectId === registration.defect.id, 'Spike defect identity mismatch');
  const defect = manifest.defects.find((item) => item.id === registration.defect.id);
  assert(defect !== undefined && defect.module === registration.defect.module, 'Spike defect is not registered in the frozen manifest');
  assert(evidence.targetRevision === registration.targetRevision && evidence.targetRevision === cleanCatalog.target.targetRevision, 'Spike target revision mismatch');

  const [phase1Bytes, trustBytes, seedBytes] = await Promise.all([
    readRepoFile(evidence.phase1Evidence.path),
    readRepoFile(evidence.phase2TrustEvidence.path),
    readRepoFile(evidence.seed.path),
  ]);
  assert(evidence.phase1Evidence.sha256 === sha256(phase1Bytes), 'Spike Phase 1 evidence reference mismatch');
  assert(evidence.phase2TrustEvidence.sha256 === sha256(trustBytes), 'Spike Phase 2 trust evidence reference mismatch');
  assert(evidence.operatorCatalog.sha256 === sha256(operatorBytes), 'Spike operator catalog reference mismatch');
  assert(evidence.seed.sha256 === sha256(seedBytes), 'Spike seed digest mismatch');
  const phase1Evidence = JSON.parse(phase1Bytes.toString('utf8'));
  const trustEvidence = JSON.parse(trustBytes.toString('utf8'));
  assert(evidence.images.cleanConsumer.imageId === phase1Evidence.image.imageId, 'Spike clean consumer image mismatch');
  assert(evidence.images.cleanTrust.imageId === trustEvidence.image.imageId, 'Spike clean trust image mismatch');
  for (const image of Object.values(evidence.images)) {
    assert(validImageId(image.imageId), 'Spike image identity is invalid');
  }

  assert(evidence.cleanArtifactDigest === cleanCatalog.target.artifactSha256, 'Spike clean artifact digest mismatch');
  assert(evidence.defectArtifactDigest !== evidence.cleanArtifactDigest, 'Spike defect artifact digest equals the clean digest');
  assert(evidence.defectTarballDigests[cleanCatalog.target.moduleId] === evidence.defectArtifactDigest, 'Spike defect tarball digest mismatch');
  for (const artifact of phase1Evidence.probe.artifacts) {
    if (artifact.id === cleanCatalog.target.moduleId) continue;
    assert(evidence.defectTarballDigests[artifact.id] === artifact.sha256, `Spike defect build changed a non-target artifact: ${artifact.id}`);
  }
  const dockerfileSource = (await readRepoFile(evidence.consumerDockerfilePatch.file)).toString('utf8');
  const patchedConsumerDockerfile = applyEdit(dockerfileSource, evidence.consumerDockerfilePatch);
  assert(Array.isArray(evidence.defectConsumerLockfile.changedIntegrityLines)
    && evidence.defectConsumerLockfile.changedIntegrityLines.length >= 1
    && evidence.defectConsumerLockfile.changedIntegrityLines.length <= 8, 'Spike defect lockfile diff record is out of bounds');
  assert(canonicalJson(evidence.executionBudget) === canonicalJson(EXECUTION_BUDGET), 'Spike execution budget mismatch');

  const baseCatalogJson = JSON.parse(catalogBytes.toString('utf8'));
  baseCatalogJson.target.artifactSha256 = evidence.defectArtifactDigest;
  const defectCatalogBytes = Buffer.from(`${JSON.stringify(baseCatalogJson, null, 2)}\n`);
  const expectedDefectBuildInputs = {
    contractImageId: evidence.images.defectConsumer.imageId,
    targetRevision: registration.targetRevision,
    targetArtifactDigest: evidence.defectArtifactDigest,
    defectId: defect.id,
    catalogSha256: sha256(defectCatalogBytes),
    consumerDockerfileSha256: sha256(patchedConsumerDockerfile),
    trustDockerfileSha256: sha256(await readRepoFile('docker-v0.3/Dockerfile.trust')),
    harnessFiles: HARNESS_FILES,
    harnessSha256: await aggregateFiles(repositoryRoot, HARNESS_FILES),
    sourceFiles: SOURCE_FILES,
    sourceSha256: await aggregateFiles(repositoryRoot, SOURCE_FILES),
    prepareScriptSha256: sha256(await readRepoFile('scripts/prepare-v03-spike.mjs')),
    operatorCatalogSha256: sha256(operatorBytes),
  };
  assert(canonicalJson(evidence.defectBuildInputs) === canonicalJson(expectedDefectBuildInputs), 'Spike defect build inputs changed');
  assert(evidence.defectEvaluationContractKey === domainDigest('bug-dreamer/evaluation-contract/v1', expectedDefectBuildInputs), 'Spike defect evaluation contract key mismatch');
  const expectedSpikeBuildInputs = {
    registrationSha256: sha256(registrationBytes),
    spikeDockerfileSha256: sha256(await readRepoFile('docker-v0.3/Dockerfile.spike')),
    operatorModuleSha256: sha256(await readRepoFile('src/v03-operators.mjs')),
    operatorCatalogSha256: sha256(operatorBytes),
  };
  assert(canonicalJson(evidence.spikeBuildInputs) === canonicalJson(expectedSpikeBuildInputs), 'Spike build inputs changed');
  assert(evidence.spikeContractKeys.clean === domainDigest('bug-dreamer/spike-contract/v1', { ...expectedSpikeBuildInputs, baseImageId: evidence.images.cleanTrust.imageId }), 'Clean spike contract key mismatch');
  assert(evidence.spikeContractKeys.defect === domainDigest('bug-dreamer/spike-contract/v1', { ...expectedSpikeBuildInputs, baseImageId: evidence.images.defectTrust.imageId }), 'Defect spike contract key mismatch');

  const defectCatalog = {
    ...cleanCatalog,
    target: { ...cleanCatalog.target, artifactSha256: evidence.defectArtifactDigest },
  };
  const cleanSeed = parseNightmareSeed(seedBytes, cleanCatalog);
  const defectSeed = parseNightmareSeed(seedBytes, defectCatalog);

  let structuralRejection;
  try {
    buildNightmareSpec(cleanSeed, cleanCatalog);
    fail('Baseline identity spec was unexpectedly accepted');
  } catch (error) {
    structuralRejection = rejectionRecord(error);
  }
  assert(canonicalJson(evidence.baseline.structuralRejection) === canonicalJson({ seedPath: evidence.seed.path, spec: structuralRejection }), 'Spike structural rejection mismatch');
  const specCasesBytes = await readRepoFile(SPEC_CASES_PATH);
  assert(evidence.baseline.specCases.path === SPEC_CASES_PATH && evidence.baseline.specCases.sha256 === sha256(specCasesBytes), 'Spike baseline universe digest mismatch');
  const specCases = parseJsonBytes(specCasesBytes);
  assert(Array.isArray(evidence.baseline.identityRuns) && evidence.baseline.identityRuns.length === specCases.positive.length, 'Spike baseline run count mismatch');
  const baselineIdentities = [];
  for (const [index, relativePath] of specCases.positive.entries()) {
    const recorded = evidence.baseline.identityRuns[index];
    assert(recorded.seedPath === relativePath, `Spike baseline seed order mismatch: ${relativePath}`);
    const baselineSeedBytes = await readRepoFile(relativePath);
    assert(recorded.seedSha256 === sha256(baselineSeedBytes), `Spike baseline seed digest mismatch: ${relativePath}`);
    const baselineSeed = parseNightmareSeed(baselineSeedBytes, defectCatalog);
    const baselineSpec = buildNightmareSpec(baselineSeed, defectCatalog);
    const baselinePlan = buildExecutionPlan(baselineSpec, defectCatalog);
    assert(recorded.specDigest === specDigest(baselineSpec, defectCatalog), `Spike baseline spec digest mismatch: ${relativePath}`);
    assert(recorded.planDigest === planDigest(baselinePlan, baselineSpec, defectCatalog), `Spike baseline plan digest mismatch: ${relativePath}`);
    const classification = recomputeRun(recorded.run, baselinePlan, baselineSpec, defectCatalog, `baseline ${relativePath}`);
    baselineIdentities.push(classification.violationIdentity);
  }
  assert(evidence.baseline.evaluatedSpecs === 1 + evidence.baseline.identityRuns.length, 'Spike baseline evaluated spec count mismatch');
  assert(evidence.baseline.evaluatedSpecs <= registration.arms.baseline.maxEvaluatedSpecs, 'Spike baseline arm exceeded its registered budget');

  assert(Array.isArray(evidence.arms) && evidence.arms.length === OPERATOR_ARM_REQUESTS.length, 'Spike arm count mismatch');
  let adopted = null;
  let adoptedIdentity = null;
  let operatorEvaluatedSpecs = 0;
  for (const [index, entry] of OPERATOR_ARM_REQUESTS.entries()) {
    const recorded = evidence.arms[index];
    assert(recorded.operatorId === entry.operatorId && recorded.requestPath === entry.requestPath, `Spike arm identity mismatch: ${entry.operatorId}`);
    const requestBytes = await readRepoFile(entry.requestPath);
    assert(recorded.requestSha256 === sha256(requestBytes), `Spike arm request digest mismatch: ${entry.operatorId}`);
    const request = JSON.parse(requestBytes.toString('utf8'));
    let cleanSpec;
    try {
      cleanSpec = buildTransformedSpec(cleanSeed, request, cleanCatalog, operatorCatalog);
    } catch (error) {
      const observed = rejectionRecord(error);
      assert(canonicalJson(recorded.rejection) === canonicalJson(observed), `Spike arm rejection mismatch: ${entry.operatorId}`);
      operatorEvaluatedSpecs += 1;
      continue;
    }
    assert(recorded.rejection === undefined, `Spike arm was rejected during replay: ${entry.operatorId}`);
    const cleanPlan = buildExecutionPlan(cleanSpec, cleanCatalog);
    const defectSpec = buildTransformedSpec(defectSeed, request, defectCatalog, operatorCatalog);
    const defectPlan = buildExecutionPlan(defectSpec, defectCatalog);
    assert(recorded.cleanSpecDigest === specDigest(cleanSpec, cleanCatalog), `Spike clean spec digest mismatch: ${entry.operatorId}`);
    assert(recorded.cleanPlanDigest === planDigest(cleanPlan, cleanSpec, cleanCatalog), `Spike clean plan digest mismatch: ${entry.operatorId}`);
    assert(recorded.defectSpecDigest === specDigest(defectSpec, defectCatalog), `Spike defect spec digest mismatch: ${entry.operatorId}`);
    assert(recorded.defectPlanDigest === planDigest(defectPlan, defectSpec, defectCatalog), `Spike defect plan digest mismatch: ${entry.operatorId}`);
    const cleanClassification = recomputeRun(recorded.cleanRun, cleanPlan, cleanSpec, cleanCatalog, `${entry.operatorId} clean`);
    const defectClassification = recomputeRun(recorded.defectRun, defectPlan, defectSpec, defectCatalog, `${entry.operatorId} defect`);
    const twoSided = defectClassification.execution.status === 'candidate-failure'
      && defectClassification.violationIdentity !== null
      && cleanClassification.execution.status === 'pass';
    assert(recorded.twoSided === twoSided, `Spike two-sided record mismatch: ${entry.operatorId}`);
    operatorEvaluatedSpecs += 2;
    if (twoSided) {
      assert(Array.isArray(recorded.repeatRuns) && recorded.repeatRuns.length === 5, `Spike repeat run count mismatch: ${entry.operatorId}`);
      const expectedIdentity = canonicalJson(defectClassification.violationIdentity);
      let fiveOfFive = true;
      for (const [attempt, repeatRun] of recorded.repeatRuns.entries()) {
        const repeatClassification = recomputeRun(repeatRun, defectPlan, defectSpec, defectCatalog, `${entry.operatorId} repeat ${attempt}`);
        if (repeatClassification.violationIdentity === null || canonicalJson(repeatClassification.violationIdentity) !== expectedIdentity) fiveOfFive = false;
      }
      assert(recorded.fiveOfFive === fiveOfFive, `Spike five-of-five record mismatch: ${entry.operatorId}`);
      operatorEvaluatedSpecs += recorded.repeatRuns.length;
      if (fiveOfFive && adopted === null) {
        adopted = entry.operatorId;
        adoptedIdentity = expectedIdentity;
      }
    }
  }
  if (adopted !== null) {
    for (const identity of baselineIdentities) {
      assert(identity === null || canonicalJson(identity) !== adoptedIdentity, 'A baseline identity run reproduced the operator candidate');
    }
  }
  assert(canonicalJson(evidence.evaluatedSpecs) === canonicalJson({ baseline: evidence.baseline.evaluatedSpecs, operator: operatorEvaluatedSpecs }), 'Spike evaluated spec count mismatch');
  assert(operatorEvaluatedSpecs <= registration.arms.operator.maxEvaluatedSpecs, 'Spike operator arm exceeded its registered budget');
  const verdict = adopted !== null ? 'adopt' : 'retire';
  assert(evidence.verdict === verdict && (evidence.adoptedOperatorId ?? null) === adopted, 'Spike verdict mismatch');
  return {
    verdict,
    adoptedOperatorId: adopted,
    armCount: evidence.arms.length,
    baselineRunCount: evidence.baseline.identityRuns.length,
    evaluatedSpecs: evidence.evaluatedSpecs,
    defectId: registration.defect.id,
  };
}
