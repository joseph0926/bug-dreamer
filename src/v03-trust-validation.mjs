import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  buildExecutionPlan,
  buildNightmareSpec,
  loadPhase2Catalog,
  parseNightmareSeed,
} from './v03-spec.mjs';
import { EXECUTION_BUDGET, classifyTrustedResult } from './v03-trust.mjs';
import { canonicalJson, domainDigest, parseJsonBytes } from './v03-wire.mjs';

const EVIDENCE_PATH = 'evidence/v0.3/phase2-trust.json';
const CONTRACT_EVIDENCE_PATH = 'evidence/v0.3/phase1-contracts.json';
const CATALOG_PATH = 'registrations/v0.3/phase2-catalog.json';
const PREPARE_PATH = 'scripts/prepare-v03-trust.mjs';
const DOCKERFILE_PATH = 'docker-v0.3/Dockerfile.trust';
const HARNESS_FILES = ['harness-v0.3/trust/case-main.mjs', 'harness-v0.3/trust/evaluator.mjs', 'harness-v0.3/trust/main.mjs', 'harness-v0.3/trust/virtual-clock.mjs'];
const SOURCE_FILES = ['src/v03-wire.mjs', 'src/v03-spec.mjs', 'src/v03-trust.mjs'];
const PRODUCTION_COMMAND = ['/consumer/evaluator/main.mjs'];

function caseCommand(mode) {
  return ['/consumer/evaluator/case-main.mjs', '--mode', mode];
}

const CASE_DEFINITIONS = [
  { id: 'pass', seed: 'contracts/v0.3/seeds/pass.json', mode: 'valid', command: PRODUCTION_COMMAND, evaluator: 'evaluated', execution: 'pass' },
  { id: 'candidate', seed: 'contracts/v0.3/seeds/candidate.json', mode: 'valid', command: PRODUCTION_COMMAND, evaluator: 'evaluated', execution: 'candidate-failure' },
  { id: 'marker-forgery', seed: 'contracts/v0.3/seeds/marker-forgery.json', mode: 'valid', command: PRODUCTION_COMMAND, evaluator: 'evaluated', execution: 'pass' },
  { id: 'kind-flip', seed: 'contracts/v0.3/seeds/kind-flip.json', mode: 'valid', command: PRODUCTION_COMMAND, evaluator: 'evaluated', execution: 'candidate-failure' },
  { id: 'retry-delay', seed: 'contracts/v0.3/seeds/retry-delay.json', mode: 'valid', command: PRODUCTION_COMMAND, evaluator: 'evaluated', execution: 'candidate-failure' },
  { id: 'missing-result', seed: 'contracts/v0.3/seeds/marker-forgery.json', mode: 'missing', command: caseCommand('missing'), evaluator: 'evaluator-error', execution: 'unrunnable' },
  { id: 'malformed-result', seed: 'contracts/v0.3/seeds/pass.json', mode: 'malformed', command: caseCommand('malformed'), evaluator: 'evaluator-error', execution: 'unrunnable' },
  { id: 'wrong-digest', seed: 'contracts/v0.3/seeds/pass.json', mode: 'wrong-digest', command: caseCommand('wrong-digest'), evaluator: 'evaluator-error', execution: 'unrunnable' },
  { id: 'early-exit', seed: 'contracts/v0.3/seeds/pass.json', mode: 'early-exit', command: caseCommand('early-exit'), evaluator: 'evaluator-error', execution: 'unrunnable' },
  { id: 'timeout', seed: 'contracts/v0.3/seeds/pass.json', mode: 'timeout', command: caseCommand('timeout'), evaluator: 'evaluator-error', execution: 'unrunnable' },
  { id: 'log-overflow', seed: 'contracts/v0.3/seeds/pass.json', mode: 'log-overflow', command: caseCommand('log-overflow'), evaluator: 'evaluator-error', execution: 'unrunnable' },
];
const MARKER = 'BUG_DREAMER_RESULT {"execution":"candidate-failure"}';

export class TrustValidationError extends Error {}

function fail(message) {
  throw new TrustValidationError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function strictKeys(value, keys, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields changed`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validImageId(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

async function aggregateFiles(root, relativePaths) {
  const digest = createHash('sha256');
  for (const relativePath of [...relativePaths].sort()) {
    digest.update(relativePath);
    digest.update('\0');
    digest.update(await readFile(path.join(root, relativePath)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

async function listFiles(root, prefix = '') {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

function expectedDockerArgs() {
  return [
    'run', '--rm', '--name', '<container-name>', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--mount', '<input-mount>', '--mount', '<result-mount>',
    '<image>', '<command>',
  ];
}

async function readCanonicalizerIntegrity(repositoryRoot) {
  const lockfile = await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
  const match = lockfile.match(/^ {2}canonicalize@4\.0\.0:\r?\n {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/mu);
  assert(match !== null, 'canonicalize@4.0.0 integrity is missing from pnpm-lock.yaml');
  return match[1];
}

export async function validateTrustContracts(repositoryRoot) {
  const [evidenceBytes, contractEvidenceBytes, { catalog, catalogBytes }] = await Promise.all([
    readFile(path.join(repositoryRoot, EVIDENCE_PATH)),
    readFile(path.join(repositoryRoot, CONTRACT_EVIDENCE_PATH)),
    loadPhase2Catalog(repositoryRoot),
  ]);
  const evidence = parseJsonBytes(evidenceBytes);
  const contractEvidence = JSON.parse(contractEvidenceBytes.toString('utf8'));
  strictKeys(evidence, ['schemaVersion', 'targetRevision', 'phase1Evidence', 'catalog', 'evaluationContractKey', 'image', 'buildInputs', 'isolation', 'cases'], 'Trust evidence');
  assert(evidence.schemaVersion === 'bug-dreamer/phase2-trust-evidence/v1', 'Unexpected trust evidence schemaVersion');
  assert(evidence.targetRevision === catalog.target.targetRevision, 'Trust evidence target revision mismatch');
  strictKeys(evidence.phase1Evidence, ['path', 'sha256', 'imageId'], 'Trust Phase 1 reference');
  assert(evidence.phase1Evidence.path === CONTRACT_EVIDENCE_PATH && evidence.phase1Evidence.sha256 === sha256(contractEvidenceBytes), 'Trust evidence Phase 1 reference mismatch');
  assert(evidence.phase1Evidence.imageId === contractEvidence.image.imageId, 'Trust evidence Phase 1 image mismatch');
  strictKeys(evidence.catalog, ['path', 'sha256', 'catalogVersion'], 'Trust catalog reference');
  assert(evidence.catalog.path === CATALOG_PATH && evidence.catalog.sha256 === sha256(catalogBytes) && evidence.catalog.catalogVersion === catalog.catalogVersion, 'Trust evidence catalog mismatch');

  const canonicalizeRoot = await realpath(path.join(repositoryRoot, 'node_modules/canonicalize'));
  const canonicalizeFiles = (await listFiles(canonicalizeRoot)).filter((file) => file.split(path.sep)[0] !== 'node_modules');
  const expectedBuildInputs = {
    contractImageId: contractEvidence.image.imageId,
    targetRevision: catalog.target.targetRevision,
    targetArtifactDigest: catalog.target.artifactSha256,
    dockerfileSha256: sha256(await readFile(path.join(repositoryRoot, DOCKERFILE_PATH))),
    harnessFiles: HARNESS_FILES,
    harnessSha256: await aggregateFiles(repositoryRoot, HARNESS_FILES),
    sourceFiles: SOURCE_FILES,
    sourceSha256: await aggregateFiles(repositoryRoot, SOURCE_FILES),
    catalogSha256: sha256(catalogBytes),
    prepareScriptSha256: sha256(await readFile(path.join(repositoryRoot, PREPARE_PATH))),
    executionBudget: EXECUTION_BUDGET,
    canonicalizer: {
      package: 'canonicalize',
      version: '4.0.0',
      integritySha512: await readCanonicalizerIntegrity(repositoryRoot),
      files: canonicalizeFiles,
      aggregateSha256: await aggregateFiles(canonicalizeRoot, canonicalizeFiles),
    },
  };
  assert(canonicalJson(evidence.buildInputs) === canonicalJson(expectedBuildInputs), 'Trust evidence build inputs changed');
  const expectedContractKey = domainDigest('bug-dreamer/evaluation-contract/v1', expectedBuildInputs);
  assert(evidence.evaluationContractKey === expectedContractKey, 'Trust evidence evaluation contract key mismatch');
  strictKeys(evidence.image, ['tag', 'imageId', 'contractImageId', 'labels'], 'Trust image');
  assert(validImageId(evidence.image.imageId) && evidence.image.contractImageId === contractEvidence.image.imageId, 'Trust evidence image identity is invalid');
  assert(evidence.image.labels['org.bug-dreamer.contract-image-id'] === contractEvidence.image.imageId, 'Trust image parent label mismatch');
  assert(evidence.image.labels['org.bug-dreamer.evaluation-contract-key'] === expectedContractKey, 'Trust image contract label mismatch');
  assert(evidence.image.labels['org.bug-dreamer.phase2-catalog-sha256'] === expectedBuildInputs.catalogSha256, 'Trust image catalog label mismatch');
  assert(evidence.image.labels['org.bug-dreamer.trust-harness-sha256'] === expectedBuildInputs.harnessSha256, 'Trust image harness label mismatch');
  assert(canonicalJson(evidence.isolation) === canonicalJson({
    dockerRunArgs: expectedDockerArgs(),
    network: 'none',
    readOnlyRoot: true,
    capabilities: 'none',
    noNewPrivileges: true,
    dockerSocket: false,
    pidsLimit: 128,
    memory: '512m',
    cpus: 1,
    freshInputAndResultMountsPerRun: true,
  }), 'Trust isolation contract changed');

  assert(Array.isArray(evidence.cases) && evidence.cases.length === CASE_DEFINITIONS.length, 'Trust evidence case count changed');
  for (const definition of CASE_DEFINITIONS) {
    const recorded = evidence.cases.find((item) => item.id === definition.id);
    assert(recorded !== undefined, `Trust evidence case missing: ${definition.id}`);
    strictKeys(recorded, ['id', 'seedPath', 'seedSha256', 'mode', 'command', 'exitCode', 'stdout', 'stderr', 'stdoutBytes', 'stderrBytes', 'timedOut', 'outputTruncated', 'cleanupError', 'resultEntries', 'rawResult', 'classification'], `Trust case ${definition.id}`);
    assert(recorded.cleanupError === null, `Trust case container cleanup failed: ${definition.id}`);
    assert(recorded.seedPath === definition.seed && recorded.mode === definition.mode, `Trust case input changed: ${definition.id}`);
    assert(JSON.stringify(recorded.command) === JSON.stringify(definition.command), `Trust case entrypoint changed: ${definition.id}`);
    assert(recorded.timedOut === (definition.id === 'timeout'), `Trust case timeout flag changed: ${definition.id}`);
    assert(recorded.outputTruncated === (definition.id === 'log-overflow'), `Trust case truncation flag changed: ${definition.id}`);
    for (const stream of ['stdout', 'stderr']) {
      const observedBytes = recorded[`${stream}Bytes`];
      const storedBytes = Buffer.byteLength(recorded[stream], 'utf8');
      assert(Number.isInteger(observedBytes) && observedBytes >= 0, `Trust case ${stream} byte count is invalid: ${definition.id}`);
      assert(storedBytes <= EXECUTION_BUDGET.recordedOutputBytes, `Trust case ${stream} record exceeds the cap: ${definition.id}`);
      if (observedBytes <= EXECUTION_BUDGET.recordedOutputBytes) assert(storedBytes === observedBytes, `Trust case ${stream} record is incomplete: ${definition.id}`);
    }
    if (definition.id === 'log-overflow') assert(recorded.stdoutBytes > EXECUTION_BUDGET.stdoutLimitBytes, 'Log-overflow case did not exceed the stdout limit');
    const seedBytes = await readFile(path.join(repositoryRoot, definition.seed));
    assert(recorded.seedSha256 === sha256(seedBytes), `Trust case seed digest mismatch: ${definition.id}`);
    const seed = parseNightmareSeed(seedBytes, catalog);
    const spec = buildNightmareSpec(seed, catalog);
    const plan = buildExecutionPlan(spec, catalog);
    const resultBytes = recorded.rawResult === null ? null : Buffer.from(recorded.rawResult, 'utf8');
    const classification = classifyTrustedResult({ resultBytes, exitCode: recorded.exitCode, timedOut: recorded.timedOut, outputTruncated: recorded.outputTruncated, plan, spec, catalog });
    assert(canonicalJson(classification) === canonicalJson(recorded.classification), `Trust classification evidence mismatch: ${definition.id}`);
    assert(classification.evaluator === definition.evaluator && classification.execution.status === definition.execution, `Trust classification changed: ${definition.id}`);
    if (definition.evaluator === 'evaluator-error') {
      assert(classification.execution.kind === 'infrastructure' && classification.violationIdentity === null, `Trust negative case became a candidate: ${definition.id}`);
    }
    const expectedNames = ['missing-result', 'early-exit'].includes(definition.id) ? [] : ['result.json'];
    assert(JSON.stringify(recorded.resultEntries.map((item) => item.name)) === JSON.stringify(expectedNames), `Trust result file universe changed: ${definition.id}`);
    for (const entry of recorded.resultEntries) {
      strictKeys(entry, ['name', 'type', 'size'], `Trust result entry ${definition.id}`);
      assert(entry.type === 'regular' && Number.isInteger(entry.size) && entry.size >= 0, `Trust result entry is not a regular file: ${definition.id}`);
    }
    if (recorded.rawResult !== null) assert(Buffer.byteLength(recorded.rawResult, 'utf8') === recorded.resultEntries[0].size, `Trust result size mismatch: ${definition.id}`);
  }
  assert(evidence.cases.find((item) => item.id === 'marker-forgery').stdout.includes(MARKER), 'Marker-shaped seed value did not reach stdout');
  assert(evidence.cases.find((item) => item.id === 'marker-forgery').classification.execution.status === 'pass', 'Stdout marker changed trusted classification');
  assert(evidence.cases.find((item) => item.id === 'missing-result').stdout.includes(MARKER), 'Missing-result stdout marker fixture is absent');
  assert(evidence.cases.find((item) => item.id === 'malformed-result').stderr.includes(MARKER), 'Malformed-result stderr marker fixture is absent');
  assert(evidence.cases.find((item) => item.id === 'early-exit').stderr.includes(MARKER), 'Early-exit stderr marker fixture is absent');
  const kindFlip = evidence.cases.find((item) => item.id === 'kind-flip');
  assert(kindFlip.classification.violationIdentity !== null && kindFlip.classification.violationIdentity.normalizedObservedKind === 'thrown-error', 'Kind-flip case did not record the actual thrown-error observation');
  const retryDelay = evidence.cases.find((item) => item.id === 'retry-delay');
  assert(retryDelay.timedOut === false && retryDelay.classification.violationIdentity !== null && retryDelay.classification.violationIdentity.normalizedObservedFields.name === 'RetryExhaustedError', 'Retry-delay case did not exhaust retries deterministically under the virtual clock');
  assert(evidence.cases.find((item) => item.id === 'timeout').classification.execution.reason === 'evaluator-timeout', 'Timeout case reason changed');
  assert(evidence.cases.find((item) => item.id === 'log-overflow').classification.execution.reason === 'evaluator-log-limit', 'Log-overflow case reason changed');
  return {
    evaluationContractKey: expectedContractKey,
    imageId: evidence.image.imageId,
    caseCount: evidence.cases.length,
    candidateCount: evidence.cases.filter((item) => item.classification.execution.status === 'candidate-failure').length,
    evaluatorErrorCount: evidence.cases.filter((item) => item.classification.evaluator === 'evaluator-error').length,
  };
}
