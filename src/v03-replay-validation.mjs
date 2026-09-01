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
import { canonicalJson, parseJsonBytes } from './v03-wire.mjs';

const EVIDENCE_PATH = 'evidence/v0.3/phase3-spike.json';
const REGISTRATION_PATH = 'benchmark/v0.3/phase3-spike.json';
const MANIFEST_PATH = 'benchmark/manifest.json';
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
  const [evidenceBytes, registrationBytes, manifestBytes, { catalog: cleanCatalog, operatorCatalog, operatorBytes }] = await Promise.all([
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
  assert(dockerfileSource.split(evidence.consumerDockerfilePatch.find).length - 1 === 1, 'Spike consumer Dockerfile patch anchor is not unique');
  assert(canonicalJson(evidence.executionBudget) === canonicalJson(EXECUTION_BUDGET), 'Spike execution budget mismatch');

  const defectCatalog = {
    ...cleanCatalog,
    target: { ...cleanCatalog.target, artifactSha256: evidence.defectArtifactDigest },
  };
  const cleanSeed = parseNightmareSeed(seedBytes, cleanCatalog);
  const defectSeed = parseNightmareSeed(seedBytes, defectCatalog);

  let baselineRejection;
  try {
    buildNightmareSpec(cleanSeed, cleanCatalog);
    fail('Baseline identity spec was unexpectedly accepted');
  } catch (error) {
    baselineRejection = rejectionRecord(error);
  }
  assert(canonicalJson(evidence.baseline) === canonicalJson({ evaluatedSpecs: 1, spec: baselineRejection }), 'Spike baseline record mismatch');

  assert(Array.isArray(evidence.arms) && evidence.arms.length === OPERATOR_ARM_REQUESTS.length, 'Spike arm count mismatch');
  let adopted = null;
  let evaluatedSpecs = 0;
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
      evaluatedSpecs += 1;
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
    evaluatedSpecs += 2;
    if (twoSided) {
      assert(Array.isArray(recorded.repeatRuns) && recorded.repeatRuns.length === 5, `Spike repeat run count mismatch: ${entry.operatorId}`);
      const expectedIdentity = canonicalJson(defectClassification.violationIdentity);
      let fiveOfFive = true;
      for (const [attempt, repeatRun] of recorded.repeatRuns.entries()) {
        const repeatClassification = recomputeRun(repeatRun, defectPlan, defectSpec, defectCatalog, `${entry.operatorId} repeat ${attempt}`);
        if (repeatClassification.violationIdentity === null || canonicalJson(repeatClassification.violationIdentity) !== expectedIdentity) fiveOfFive = false;
      }
      assert(recorded.fiveOfFive === fiveOfFive, `Spike five-of-five record mismatch: ${entry.operatorId}`);
      evaluatedSpecs += recorded.repeatRuns.length;
      if (fiveOfFive && adopted === null) adopted = entry.operatorId;
    }
  }
  assert(evidence.evaluatedSpecs === evaluatedSpecs, 'Spike evaluated spec count mismatch');
  assert(evaluatedSpecs <= registration.arms.operator.maxEvaluatedSpecs, 'Spike operator arm exceeded its registered budget');
  const verdict = adopted !== null ? 'adopt' : 'retire';
  assert(evidence.verdict === verdict && (evidence.adoptedOperatorId ?? null) === adopted, 'Spike verdict mismatch');
  return {
    verdict,
    adoptedOperatorId: adopted,
    armCount: evidence.arms.length,
    evaluatedSpecs,
    defectId: registration.defect.id,
  };
}
