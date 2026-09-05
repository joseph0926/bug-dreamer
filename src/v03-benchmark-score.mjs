import {
  PHASE4_APPROVED_BUDGETS,
  PHASE4_APPROVED_STATIC_POLICY_DIGEST,
  PHASE4_MODULE_IDS,
  phase4ViolationIdentityDigest,
  validatePhase4BudgetLedger,
  validatePhase4MeasurementRow,
} from './v03-benchmark-contract.mjs';

export const PHASE4_SCORER_VERSION = 'bug-dreamer/v03-benchmark-scorer/v1';

export class V03BenchmarkScoreError extends Error {}

const ARM_IDS = Object.freeze(['G', 'P', 'A', 'B', 'C', 'D', 'E']);
const OPERATOR_ARMS = Object.freeze(['A', 'B', 'C']);
const REVIEW_VERDICTS = new Set(['real-bug-worth-fixing', 'real-bug-not-worth-fixing', 'wrong-expectation', 'undecided']);
const TRUST_STATES = new Set(['pass', 'repairable-failure', 'non-repairable-failure']);
const DEVELOPMENT_TRUTH_IDS = new Set(['tx-total-timeout-resets-per-step']);
const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;

function fail(message) {
  throw new V03BenchmarkScoreError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function strictKeys(value, keys, label) {
  assert(isObject(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} fields changed`);
}

function validateId(value, label) {
  assert(typeof value === 'string' && ID.test(value), `${label} is invalid`);
}

function validateIdArray(value, label) {
  assert(Array.isArray(value), `${label} must be an array`);
  value.forEach((item) => validateId(item, label));
  assert(new Set(value).size === value.length, `${label} contains duplicates`);
}

function key(...parts) {
  return parts.join('\u0000');
}

function ratio(numerator, denominator, blocked = false) {
  if (blocked) return { numerator, denominator, value: null, status: 'blocked' };
  if (denominator === 0) return { numerator, denominator, value: null, status: 'not-applicable' };
  return { numerator, denominator, value: numerator / denominator, status: 'applicable' };
}

function sorted(values) {
  return [...values].sort();
}

function setDifference(left, right) {
  return new Set([...left].filter((item) => !right.has(item)));
}

function setSubset(left, right) {
  return [...left].every((item) => right.has(item));
}

function completed(row) {
  return row !== undefined && ['pass', 'candidate-failure'].includes(row.axes.execution);
}

function expectedViolationIdentity(row, commitment) {
  if (row?.axes.execution !== 'candidate-failure' || commitment === undefined) return null;
  const actualIdentity = phase4ViolationIdentityDigest({
    invariantRegistrationId: commitment.invariantRegistrationId,
    normalizedObservedKind: row.observation.normalizedObservedKind,
    normalizedObservedFields: row.observation.normalizedObservedFields,
    targetArtifactDigest: row.targetArtifactDigest,
  });
  assert(row.observation.violationIdentity === actualIdentity, 'Recorded violation identity disagrees with the normalized observation');
  return phase4ViolationIdentityDigest({
    invariantRegistrationId: commitment.invariantRegistrationId,
    normalizedObservedKind: commitment.expected.normalizedObservedKind,
    normalizedObservedFields: commitment.expected.normalizedObservedFields,
    targetArtifactDigest: row.targetArtifactDigest,
  });
}

function initialPair(rowsByCoordinate, commitments, armId, inputId, truthId) {
  const clean = rowsByCoordinate.get(key(armId, inputId, truthId, 'clean', 'initial', 'initial'));
  const defect = rowsByCoordinate.get(key(armId, inputId, truthId, 'single-patch-defect', 'initial', 'initial'));
  const complete = completed(clean) && completed(defect);
  const expectedIdentity = expectedViolationIdentity(defect, commitments.get(truthId));
  const raw = complete && clean.axes.execution === 'pass' && defect.axes.execution === 'candidate-failure' && defect.observation.violationIdentity === expectedIdentity;
  return {
    clean,
    defect,
    complete,
    raw,
    cleanRegression: clean?.axes.execution === 'candidate-failure',
    violationIdentity: raw ? expectedIdentity : null,
  };
}

function replayRows(rowsByCoordinate, candidate) {
  const rows = [];
  for (let replayIndex = 1; replayIndex <= candidate.expectedRuns; replayIndex += 1) {
    rows.push(rowsByCoordinate.get(key(candidate.armId, candidate.inputId, candidate.canonicalTruthId, 'single-patch-defect', 'replay', replayIndex)));
  }
  return rows;
}

function validateInput(input) {
  strictKeys(input, [
    'epochId', 'registrationStaticPolicyDigest', 'metricEligibleTruthIds', 'truthCommitments', 'retentionRows', 'acceptedSeedIds',
    'operatorRequests', 'replayCandidates', 'measurementRows', 'userReviews', 'trust', 'epochAbort', 'budgetLedger',
  ], 'Scorer input');
  assert(SHA256.test(input.epochId) && input.registrationStaticPolicyDigest === PHASE4_APPROVED_STATIC_POLICY_DIGEST, 'Scorer policy digest is not the approved static policy');
  validateIdArray(input.metricEligibleTruthIds, 'metricEligibleTruthIds');
  assert(input.metricEligibleTruthIds.every((truthId) => !DEVELOPMENT_TRUTH_IDS.has(truthId)), 'Development truth cannot enter adoption metrics');

  assert(Array.isArray(input.truthCommitments), 'truthCommitments must be an array');
  const commitmentTruths = new Set();
  for (const commitment of input.truthCommitments) {
    strictKeys(commitment, ['canonicalTruthId', 'moduleId', 'duplicateGroup', 'invariantRegistrationId', 'matcherId', 'expected'], 'Truth commitment');
    validateId(commitment.canonicalTruthId, 'Truth commitment ID');
    validateId(commitment.duplicateGroup, 'Truth commitment duplicate group');
    validateId(commitment.invariantRegistrationId, 'Truth commitment invariant');
    validateId(commitment.matcherId, 'Truth commitment matcher');
    assert(PHASE4_MODULE_IDS.includes(commitment.moduleId), 'Truth commitment module is invalid');
    strictKeys(commitment.expected, ['normalizedObservedKind', 'normalizedObservedFields'], 'Truth commitment expectation');
    assert(['returned-value', 'thrown-error'].includes(commitment.expected.normalizedObservedKind), 'Truth commitment observation kind is invalid');
    assert(isObject(commitment.expected.normalizedObservedFields), 'Truth commitment observed fields are invalid');
    assert(!commitmentTruths.has(commitment.canonicalTruthId), 'Truth commitment is duplicated');
    commitmentTruths.add(commitment.canonicalTruthId);
  }
  assert(input.metricEligibleTruthIds.every((truthId) => commitmentTruths.has(truthId)), 'Metric-eligible truth is missing its commitment');

  assert(Array.isArray(input.retentionRows), 'retentionRows must be an array');
  const retentionIds = new Set();
  for (const row of input.retentionRows) {
    strictKeys(row, ['rowId', 'moduleId', 'canonicalTruthId', 'duplicateGroup'], 'Retention row');
    validateId(row.rowId, 'Retention row ID');
    validateId(row.canonicalTruthId, 'Retention truth ID');
    validateId(row.duplicateGroup, 'Retention duplicate group');
    assert(PHASE4_MODULE_IDS.includes(row.moduleId), 'Retention module is invalid');
    assert(!retentionIds.has(row.rowId), 'Retention row ID is duplicated');
    assert(!DEVELOPMENT_TRUTH_IDS.has(row.canonicalTruthId), 'Development row cannot support pipeline adoption');
    retentionIds.add(row.rowId);
  }
  assert(input.retentionRows.every((row) => commitmentTruths.has(row.canonicalTruthId)), 'Retention row is missing its truth commitment');

  strictKeys(input.acceptedSeedIds, ['G', 'P'], 'acceptedSeedIds');
  validateIdArray(input.acceptedSeedIds.G, 'acceptedSeedIds.G');
  validateIdArray(input.acceptedSeedIds.P, 'acceptedSeedIds.P');

  assert(Array.isArray(input.operatorRequests), 'operatorRequests must be an array');
  const requestIds = new Set();
  for (const request of input.operatorRequests) {
    strictKeys(request, ['requestId', 'inputId', 'armId', 'moduleId', 'applicable', 'reasonCode'], 'Operator request');
    validateId(request.requestId, 'Operator request ID');
    validateId(request.inputId, 'Operator input ID');
    assert(OPERATOR_ARMS.includes(request.armId) && PHASE4_MODULE_IDS.includes(request.moduleId), 'Operator request coordinate is invalid');
    assert(typeof request.applicable === 'boolean', 'Operator applicability is invalid');
    assert(input.acceptedSeedIds.P.includes(request.inputId), 'Operator request does not use a frozen P seed');
    assert(request.reasonCode === null || ID.test(request.reasonCode), 'Operator reason code is invalid');
    assert(!requestIds.has(request.requestId), 'Operator request ID is duplicated');
    requestIds.add(request.requestId);
  }

  assert(Array.isArray(input.replayCandidates), 'replayCandidates must be an array');
  const replayKeys = new Set();
  for (const candidate of input.replayCandidates) {
    strictKeys(candidate, ['armId', 'inputId', 'canonicalTruthId', 'started', 'expectedRuns'], 'Replay candidate');
    assert(ARM_IDS.includes(candidate.armId) && candidate.armId !== 'D', 'Replay candidate arm is invalid');
    validateId(candidate.inputId, 'Replay input ID');
    validateId(candidate.canonicalTruthId, 'Replay truth ID');
    assert(typeof candidate.started === 'boolean' && candidate.expectedRuns === 5, 'Replay candidate policy changed');
    const candidateKey = key(candidate.armId, candidate.inputId, candidate.canonicalTruthId);
    assert(!replayKeys.has(candidateKey), 'Replay candidate is duplicated');
    replayKeys.add(candidateKey);
  }

  assert(Array.isArray(input.measurementRows), 'measurementRows must be an array');
  const sequences = new Set();
  const evaluationOrdinals = new Set();
  const coordinates = new Set();
  for (const row of input.measurementRows) {
    validatePhase4MeasurementRow(row);
    assert(row.epochId === input.epochId, 'Measurement row epoch differs from scorer epoch');
    assert(!sequences.has(row.sequence), 'Measurement sequence is duplicated');
    sequences.add(row.sequence);
    const coordinate = key(row.armId, row.inputId, row.canonicalTruthId, row.artifactRole, row.phase, row.replayIndex ?? 'initial');
    assert(!coordinates.has(coordinate), 'Measurement coordinate is duplicated');
    coordinates.add(coordinate);
    if (row.budget.charged) {
      assert(!evaluationOrdinals.has(row.budget.evaluationOrdinal), 'Evaluation ordinal is duplicated');
      evaluationOrdinals.add(row.budget.evaluationOrdinal);
    }
  }

  assert(Array.isArray(input.userReviews), 'userReviews must be an array');
  const reviewTruths = new Set();
  for (const review of input.userReviews) {
    strictKeys(review, ['canonicalTruthId', 'verdict'], 'User review');
    validateId(review.canonicalTruthId, 'Review truth ID');
    assert(REVIEW_VERDICTS.has(review.verdict), 'User review verdict is invalid');
    assert(!reviewTruths.has(review.canonicalTruthId), 'User review is duplicated');
    reviewTruths.add(review.canonicalTruthId);
  }

  strictKeys(input.trust, ['status', 'reasonCode'], 'Trust status');
  assert(TRUST_STATES.has(input.trust.status), 'Trust status is invalid');
  assert(input.trust.reasonCode === null || ID.test(input.trust.reasonCode), 'Trust reason code is invalid');
  if (input.epochAbort !== null) {
    strictKeys(input.epochAbort, ['reasonCode', 'sequence'], 'Epoch abort');
    validateId(input.epochAbort.reasonCode, 'Epoch abort reason');
    assert(Number.isSafeInteger(input.epochAbort.sequence) && input.epochAbort.sequence >= 0, 'Epoch abort sequence is invalid');
  }

  validatePhase4BudgetLedger(input.budgetLedger);
  assert(input.budgetLedger.epochId === input.epochId, 'Budget ledger epoch differs from scorer epoch');
  assert(evaluationOrdinals.size === input.budgetLedger.measurement.dockerEvaluations, 'Docker evaluation ledger disagrees with charged rows');
  for (let ordinal = 1; ordinal <= evaluationOrdinals.size; ordinal += 1) assert(evaluationOrdinals.has(ordinal), 'Evaluation ordinals are not contiguous');
  const chargedReplayRows = input.measurementRows.filter((row) => row.phase === 'replay' && row.budget.charged).length;
  assert(chargedReplayRows === input.budgetLedger.measurement.replayRuns, 'Replay ledger disagrees with charged replay rows');
  assert(input.replayCandidates.filter((candidate) => candidate.started).length === input.budgetLedger.measurement.replayCandidates, 'Replay candidate ledger disagrees with started candidates');
  assert(input.acceptedSeedIds.G.length + input.acceptedSeedIds.P.length === input.budgetLedger.generation.acceptedSeeds, 'Accepted-seed ledger disagrees with scorer input');
  assert(input.operatorRequests.length === input.budgetLedger.generation.operatorRequests, 'Operator-request ledger disagrees with scorer input');
  return input;
}

function buildIndexes(input) {
  const rowsByCoordinate = new Map();
  const truthGroups = new Map();
  const truthModules = new Map();
  for (const row of input.measurementRows) {
    rowsByCoordinate.set(key(row.armId, row.inputId, row.canonicalTruthId, row.artifactRole, row.phase, row.replayIndex ?? 'initial'), row);
    const existingGroup = truthGroups.get(row.canonicalTruthId);
    assert(existingGroup === undefined || existingGroup === row.duplicateGroup, `Truth ${row.canonicalTruthId} changes duplicate group`);
    truthGroups.set(row.canonicalTruthId, row.duplicateGroup);
    const existingModule = truthModules.get(row.canonicalTruthId);
    assert(existingModule === undefined || existingModule === row.moduleId, `Truth ${row.canonicalTruthId} changes module`);
    truthModules.set(row.canonicalTruthId, row.moduleId);
  }
  for (const truthId of input.metricEligibleTruthIds) assert(truthGroups.has(truthId) && truthModules.has(truthId), `Metric-eligible truth has no normalized row: ${truthId}`);
  return { rowsByCoordinate, truthGroups, truthModules };
}

function reviewIndex(input, truthGroups) {
  const byGroup = new Map();
  for (const review of input.userReviews) {
    const group = truthGroups.get(review.canonicalTruthId) ?? review.canonicalTruthId;
    const existing = byGroup.get(group);
    assert(existing === undefined || existing === review.verdict, `Duplicate group has conflicting user reviews: ${group}`);
    byGroup.set(group, review.verdict);
  }
  return byGroup;
}

function expectedSeedPairs(input, armId, rowsByCoordinate, truthModules, commitments) {
  const pairs = [];
  let missingModule = false;
  const coveredModules = new Set();
  const requiredModules = new Set(input.metricEligibleTruthIds.map((truthId) => truthModules.get(truthId)));
  for (const inputId of input.acceptedSeedIds[armId]) {
    const seedRows = input.measurementRows.filter((row) => row.armId === armId && row.inputId === inputId && row.phase === 'initial');
    const modules = new Set(seedRows.map((row) => row.moduleId));
    if (modules.size !== 1) {
      missingModule = true;
      continue;
    }
    const [moduleId] = modules;
    coveredModules.add(moduleId);
    for (const truthId of input.metricEligibleTruthIds.filter((candidate) => truthModules.get(candidate) === moduleId)) {
      pairs.push({ inputId, truthId, moduleId, pair: initialPair(rowsByCoordinate, commitments, armId, inputId, truthId) });
    }
  }
  const moduleCoverage = [...requiredModules].every((moduleId) => coveredModules.has(moduleId));
  return { pairs, complete: !missingModule && moduleCoverage && pairs.every((item) => item.pair.complete), modules: sorted(coveredModules) };
}

function canonicalGroups(truthIds, truthGroups) {
  return new Set(truthIds.map((truthId) => truthGroups.get(truthId) ?? truthId));
}

function replayFacts(input, rowsByCoordinate, truthGroups, commitments) {
  const facts = new Map();
  for (const candidate of input.replayCandidates) {
    const pair = initialPair(rowsByCoordinate, commitments, candidate.armId, candidate.inputId, candidate.canonicalTruthId);
    const rows = replayRows(rowsByCoordinate, candidate);
    const presentRows = rows.filter((row) => row !== undefined);
    if (!candidate.started) assert(presentRows.length === 0, 'Replay rows exist for a candidate that did not start');
    if (candidate.started) {
      assert(presentRows.every((row) => row.runRecordRef !== null), 'Started replay is missing its run reference');
      const runRefs = presentRows.map((row) => row.runRecordRef);
      assert(new Set(runRefs).size === runRefs.length, 'Replay runs reuse one run reference');
      assert(!pair.defect?.runRecordRef || !runRefs.includes(pair.defect.runRecordRef), 'Replay reuses the initial observation run');
    }
    const complete = candidate.started && rows.every(completed);
    const confirmed = pair.raw && complete && rows.every((row) => {
      const expectedIdentity = expectedViolationIdentity(row, commitments.get(candidate.canonicalTruthId));
      return row.observation.violationIdentity === pair.violationIdentity && row.observation.violationIdentity === expectedIdentity;
    });
    facts.set(key(candidate.armId, candidate.inputId, candidate.canonicalTruthId), {
      ...candidate,
      group: truthGroups.get(candidate.canonicalTruthId) ?? candidate.canonicalTruthId,
      pair,
      rows,
      complete,
      confirmed,
    });
  }
  return facts;
}

function armFacts(input, armId, rowsByCoordinate, truthGroups, replayByCandidate, eligibleGroups, commitments) {
  const initialCoordinates = new Map();
  for (const row of input.measurementRows) {
    if (row.armId !== armId || row.phase !== 'initial') continue;
    initialCoordinates.set(key(row.inputId, row.canonicalTruthId), { inputId: row.inputId, truthId: row.canonicalTruthId });
  }
  const pairs = [...initialCoordinates.values()].map(({ inputId, truthId }) => ({ inputId, truthId, pair: initialPair(rowsByCoordinate, commitments, armId, inputId, truthId) }));
  const eligiblePairs = pairs.filter((item) => eligibleGroups.has(truthGroups.get(item.truthId) ?? item.truthId));
  const rawGroups = canonicalGroups(eligiblePairs.filter((item) => item.pair.raw).map((item) => item.truthId), truthGroups);
  const candidateGroups = canonicalGroups(eligiblePairs.filter((item) => item.pair.clean?.axes.execution === 'candidate-failure' || item.pair.defect?.axes.execution === 'candidate-failure').map((item) => item.truthId), truthGroups);
  const confirmedGroups = new Set([...replayByCandidate.values()].filter((item) => item.armId === armId && item.confirmed && eligibleGroups.has(item.group)).map((item) => item.group));
  const startedRows = input.measurementRows.filter((row) => row.armId === armId && row.budget.charged && eligibleGroups.has(truthGroups.get(row.canonicalTruthId) ?? row.canonicalTruthId));
  return {
    pairs,
    rawGroups,
    candidateGroups,
    confirmedGroups,
    cleanRegression: eligiblePairs.some((item) => item.pair.cleanRegression),
    infrastructureRate: ratio(startedRows.filter((row) => row.axes.execution === 'unrunnable').length, startedRows.length),
    replayComplete: [...replayByCandidate.values()].filter((item) => item.armId === armId && item.started && eligibleGroups.has(item.group)).every((item) => item.complete),
  };
}

function reviewMetrics(groups, reviews) {
  let wrong = 0;
  let valid = 0;
  let blocked = false;
  for (const group of groups) {
    const verdict = reviews.get(group);
    if (verdict === undefined || verdict === 'undecided') blocked = true;
    if (verdict === 'wrong-expectation') wrong += 1;
    if (verdict === 'real-bug-worth-fixing' || verdict === 'real-bug-not-worth-fixing') valid += 1;
  }
  return {
    complete: !blocked,
    falseOracleRate: ratio(wrong, groups.size, blocked),
    validCount: valid,
  };
}

function budgetFacts(input) {
  const { generation, measurement, preparation, stoppedBy } = input.budgetLedger;
  const limits = PHASE4_APPROVED_BUDGETS;
  const exhausted = stoppedBy !== null || input.measurementRows.some((row) => row.reasonCode === 'budget-exhausted');
  const withinGeneration = generation.freshSessions <= 2
    && generation.submittedTaskTurns <= 2
    && generation.emittedSeeds <= 12
    && generation.acceptedSeeds <= 12
    && generation.operatorRequests <= 18
    && generation.transformedSpecs <= 18;
  const requiredAuthoringUnitsComplete = generation.freshSessions === 2 && generation.submittedTaskTurns === 2;
  return {
    passed: withinGeneration && requiredAuthoringUnitsComplete && !exhausted,
    exhausted,
    utilization: {
      freshGenerationSessions: ratio(generation.freshSessions, 2),
      submittedGenerationTaskTurns: ratio(generation.submittedTaskTurns, 2),
      emittedSeedFiles: ratio(generation.emittedSeeds, 12),
      acceptedSeeds: ratio(generation.acceptedSeeds, 12),
      operatorRequests: ratio(generation.operatorRequests, 18),
      transformedSpecs: ratio(generation.transformedSpecs, 18),
      dockerEvaluations: ratio(measurement.dockerEvaluations, limits.measurement.dockerEvaluationMaximum),
      timeoutSeconds: ratio(measurement.dockerEvaluations * (limits.evaluation.timeoutMs / 1000), limits.measurement.timeoutSecondsMaximum),
      measurementWallClockSeconds: ratio(measurement.elapsedSeconds, limits.measurement.monotonicWallClockSecondsMaximum),
      replayCandidates: ratio(measurement.replayCandidates, limits.replay.candidateMaximum),
      replayRuns: ratio(measurement.replayRuns, limits.replay.dockerEvaluationMaximum),
      preparationBuilds: ratio(preparation.builds, limits.preparation.dockerBuildMaximum),
      preparationInspectOrProbe: ratio(preparation.inspects + preparation.probeContainers, limits.preparation.dockerInspectOrProbeMaximum),
      preparationFailures: { numerator: preparation.failures, denominator: 0, value: preparation.failures === 0 ? 0 : null, status: preparation.failures === 0 ? 'applicable' : 'failed' },
      preparationWallClockSeconds: ratio(preparation.elapsedSeconds, limits.preparation.monotonicWallClockSecondsMaximum),
    },
  };
}

function verdict(input, blockers, adopt, retire) {
  if (input.epochAbort !== null) return { verdict: 'abort', branch: 'epoch-abort', reasons: [input.epochAbort.reasonCode] };
  if (input.trust.status === 'non-repairable-failure') return { verdict: 'retire', branch: 'non-repairable-trust-failure-retire', reasons: [input.trust.reasonCode ?? 'non-repairable-trust-failure'] };
  const reasons = [...new Set(blockers.filter(Boolean))].sort();
  if (reasons.length > 0) return { verdict: 'revise', branch: 'incomplete-or-zero-denominator-or-coverage-gap-or-normal-budget-exhaustion-or-high-infrastructure-rate-or-clean-regression-or-repairable-issue-revise', reasons };
  if (adopt) return { verdict: 'adopt', branch: 'strategy-adopt', reasons: [] };
  if (retire) return { verdict: 'retire', branch: 'sufficient-counterevidence-retire', reasons: [] };
  return { verdict: 'revise', branch: 'otherwise-revise', reasons: [] };
}

export function scorePhase4Benchmark(sourceInput) {
  const input = validateInput(sourceInput);
  const { rowsByCoordinate, truthGroups, truthModules } = buildIndexes(input);
  const commitments = new Map(input.truthCommitments.map((commitment) => [commitment.canonicalTruthId, commitment]));
  for (const row of input.measurementRows) {
    const commitment = commitments.get(row.canonicalTruthId);
    assert(commitment !== undefined, `Measurement row is missing its truth commitment: ${row.canonicalTruthId}`);
    if (row.axes.execution === 'candidate-failure') expectedViolationIdentity(row, commitment);
  }
  for (const [truthId, commitment] of commitments) {
    if (!truthGroups.has(truthId)) continue;
    assert(truthGroups.get(truthId) === commitment.duplicateGroup, `Truth commitment duplicate group differs from normalized rows: ${truthId}`);
    assert(truthModules.get(truthId) === commitment.moduleId, `Truth commitment module differs from normalized rows: ${truthId}`);
  }
  for (const retentionRow of input.retentionRows) {
    assert(truthGroups.get(retentionRow.canonicalTruthId) === retentionRow.duplicateGroup, `Retention row duplicate group differs from normalized rows: ${retentionRow.rowId}`);
    assert(truthModules.get(retentionRow.canonicalTruthId) === retentionRow.moduleId, `Retention row module differs from normalized rows: ${retentionRow.rowId}`);
  }
  for (const armId of ['G', 'P', 'A', 'B', 'C']) {
    assert(input.replayCandidates.filter((candidate) => candidate.armId === armId).length <= 2, `Replay candidate quota exceeded for ${armId}`);
  }
  const requestCoordinates = new Set(input.operatorRequests.map((request) => key(request.armId, request.inputId)));
  const retentionCoordinates = new Set(input.retentionRows.map((row) => key(row.rowId, row.canonicalTruthId)));
  for (const candidate of input.replayCandidates) {
    if (['G', 'P'].includes(candidate.armId)) assert(input.acceptedSeedIds[candidate.armId].includes(candidate.inputId), 'Generation replay does not belong to an accepted seed');
    if (OPERATOR_ARMS.includes(candidate.armId)) assert(requestCoordinates.has(key(candidate.armId, candidate.inputId)), 'Operator replay does not belong to a recorded request');
    if (candidate.armId === 'E') assert(retentionCoordinates.has(key(candidate.inputId, candidate.canonicalTruthId)), 'E replay does not belong to the frozen retention denominator');
  }
  for (const retentionRow of input.retentionRows) {
    assert(input.replayCandidates.some((candidate) => candidate.armId === 'E' && candidate.inputId === retentionRow.rowId && candidate.canonicalTruthId === retentionRow.canonicalTruthId), `Frozen retention row is missing its E replay record: ${retentionRow.rowId}`);
  }
  const reviews = reviewIndex(input, truthGroups);
  const replayByCandidate = replayFacts(input, rowsByCoordinate, truthGroups, commitments);
  const eligibleGroups = canonicalGroups(input.metricEligibleTruthIds, truthGroups);
  const arms = Object.fromEntries(ARM_IDS.map((armId) => [armId, armFacts(input, armId, rowsByCoordinate, truthGroups, replayByCandidate, eligibleGroups, commitments)]));
  const budget = budgetFacts(input);

  const generation = {};
  const generationCoverage = {};
  for (const armId of ['G', 'P']) {
    const expected = expectedSeedPairs(input, armId, rowsByCoordinate, truthModules, commitments);
    const review = reviewMetrics(arms[armId].candidateGroups, reviews);
    const confirmedReview = reviewMetrics(arms[armId].confirmedGroups, reviews);
    generationCoverage[armId] = expected;
    generation[armId] = {
      rawTruthIds: sorted(arms[armId].rawGroups),
      replayConfirmedTruthIds: sorted(arms[armId].confirmedGroups),
      rawTwoSidedCandidateRate: ratio(arms[armId].rawGroups.size, eligibleGroups.size),
      replayConfirmedCatchRate: ratio(arms[armId].confirmedGroups.size, eligibleGroups.size),
      validBugYieldPerAcceptedSeed: ratio(confirmedReview.validCount, input.acceptedSeedIds[armId].length, !confirmedReview.complete),
      falseOracleRate: review.falseOracleRate,
      fiveOfFiveRate: ratio(
        [...replayByCandidate.values()].filter((item) => item.armId === armId && item.confirmed && eligibleGroups.has(item.group)).length,
        [...replayByCandidate.values()].filter((item) => item.armId === armId && item.started && eligibleGroups.has(item.group)).length,
      ),
      complete: expected.complete && arms[armId].replayComplete,
      reviewComplete: review.complete && confirmedReview.complete,
    };
  }

  const generationBlockers = [];
  if (eligibleGroups.size === 0 || input.acceptedSeedIds.G.length === 0 || input.acceptedSeedIds.P.length === 0 || arms.G.candidateGroups.size === 0 || arms.P.candidateGroups.size === 0) generationBlockers.push('zero-denominator');
  if (!generation.G.complete || !generation.P.complete) generationBlockers.push('incomplete-evidence');
  if (!generation.G.reviewComplete || !generation.P.reviewComplete) generationBlockers.push('user-review-required');
  if (arms.G.cleanRegression || arms.P.cleanRegression) generationBlockers.push('clean-regression');
  if ((arms.G.infrastructureRate.value ?? 0) > 0.05 || (arms.P.infrastructureRate.value ?? 0) > 0.05) generationBlockers.push('high-infrastructure-rate');
  if (!budget.passed) generationBlockers.push(budget.exhausted ? 'budget-exhausted' : 'budget-invalid');
  if (input.trust.status === 'repairable-failure') generationBlockers.push('repairable-trust-failure');
  const generationAdopt = setSubset(arms.G.confirmedGroups, arms.P.confirmedGroups)
    && generation.P.falseOracleRate.status === 'applicable'
    && generation.G.falseOracleRate.status === 'applicable'
    && generation.P.falseOracleRate.value <= generation.G.falseOracleRate.value;
  const generationRetire = arms.P.confirmedGroups.size < arms.G.confirmedGroups.size
    && generation.P.falseOracleRate.status === 'applicable'
    && generation.G.falseOracleRate.status === 'applicable'
    && generation.P.falseOracleRate.value > generation.G.falseOracleRate.value;

  const pRawBaseline = arms.P.rawGroups;
  const operatorConfirmed = new Set(OPERATOR_ARMS.flatMap((armId) => [...arms[armId].confirmedGroups]));
  const incremental = setDifference(operatorConfirmed, pRawBaseline);
  const completeApplicableRequests = input.operatorRequests.filter((request) => {
    if (!request.applicable) return false;
    const relevantTruths = input.metricEligibleTruthIds.filter((truthId) => truthModules.get(truthId) === request.moduleId);
    return relevantTruths.length > 0 && relevantTruths.every((truthId) => initialPair(rowsByCoordinate, commitments, request.armId, request.inputId, truthId).complete);
  });
  const operatorCandidateGroups = new Set(OPERATOR_ARMS.flatMap((armId) => [...arms[armId].candidateGroups]));
  const operatorReview = reviewMetrics(operatorCandidateGroups, reviews);
  const operatorStartedRows = input.measurementRows.filter((row) => OPERATOR_ARMS.includes(row.armId) && row.budget.charged && eligibleGroups.has(truthGroups.get(row.canonicalTruthId) ?? row.canonicalTruthId));
  const operatorInfrastructureRate = ratio(operatorStartedRows.filter((row) => row.axes.execution === 'unrunnable').length, operatorStartedRows.length);
  const operatorCleanRegression = OPERATOR_ARMS.some((armId) => arms[armId].cleanRegression);
  const operatorBlockers = [];
  if (input.operatorRequests.length === 0) operatorBlockers.push('zero-denominator');
  const expectedOperatorCoordinates = new Set(OPERATOR_ARMS.flatMap((armId) => input.acceptedSeedIds.P.map((inputId) => key(armId, inputId))));
  if (requestCoordinates.size !== expectedOperatorCoordinates.size || [...expectedOperatorCoordinates].some((coordinate) => !requestCoordinates.has(coordinate))) operatorBlockers.push('incomplete-operator-requests');
  if (!generationCoverage.P.complete) operatorBlockers.push('incomplete-p-baseline');
  if (!operatorReview.complete) operatorBlockers.push('user-review-required');
  if (operatorCleanRegression) operatorBlockers.push('clean-regression');
  if ((operatorInfrastructureRate.value ?? 0) > 0.05) operatorBlockers.push('high-infrastructure-rate');
  if (!budget.passed) operatorBlockers.push(budget.exhausted ? 'budget-exhausted' : 'budget-invalid');
  if (input.trust.status === 'repairable-failure') operatorBlockers.push('repairable-trust-failure');
  const completeApplicableModules = new Set(completeApplicableRequests.map((request) => request.moduleId));
  const operatorRetireCoverage = completeApplicableRequests.length >= 6 && PHASE4_MODULE_IDS.every((moduleId) => completeApplicableModules.has(moduleId));
  const operator = {
    replayConfirmedTruthIds: sorted(operatorConfirmed),
    pCompleteRawBaselineTruthIds: sorted(pRawBaseline),
    incrementalTruthIds: sorted(incremental),
    incrementalYield: incremental.size,
    applicabilityRate: ratio(input.operatorRequests.filter((request) => request.applicable).length, input.operatorRequests.length),
    completeApplicableSpecCount: completeApplicableRequests.length,
    completeApplicableModules: sorted(completeApplicableModules),
    infrastructureRate: operatorInfrastructureRate,
  };

  const retention = [];
  let validAnchors = true;
  let completeRetention = true;
  let retainedCount = 0;
  for (const row of input.retentionRows) {
    const d = initialPair(rowsByCoordinate, commitments, 'D', row.rowId, row.canonicalTruthId);
    const e = initialPair(rowsByCoordinate, commitments, 'E', row.rowId, row.canonicalTruthId);
    const candidate = replayByCandidate.get(key('E', row.rowId, row.canonicalTruthId));
    const anchorValid = d.raw;
    const eIdentityMatches = e.raw && anchorValid && e.violationIdentity === d.violationIdentity;
    const replayComplete = candidate?.complete === true;
    const replayIdentityMatches = replayComplete && candidate.rows.every((replayRow) => replayRow.axes.execution === 'candidate-failure' && replayRow.observation.violationIdentity === d.violationIdentity);
    const retained = anchorValid && eIdentityMatches && replayIdentityMatches;
    validAnchors &&= anchorValid;
    completeRetention &&= d.complete && e.complete && replayComplete;
    if (retained) retainedCount += 1;
    retention.push({ rowId: row.rowId, canonicalTruthId: row.canonicalTruthId, anchorValid, eIdentityMatches, replayComplete, replayIdentityMatches, retained });
  }
  const retentionGroups = canonicalGroups(input.retentionRows.map((row) => row.canonicalTruthId), truthGroups);
  const retentionReview = reviewMetrics(retentionGroups, reviews);
  const retentionModules = new Set(input.retentionRows.map((row) => row.moduleId));
  const pipelineRows = input.measurementRows.filter((row) => ['D', 'E'].includes(row.armId) && row.budget.charged);
  const pipelineInfrastructureRate = ratio(pipelineRows.filter((row) => row.axes.execution === 'unrunnable').length, pipelineRows.length);
  const pipelineCleanRegression = arms.D.cleanRegression || arms.E.cleanRegression;
  const retentionMetric = ratio(retainedCount, input.retentionRows.length);
  const pipelineBlockers = [];
  if (input.retentionRows.length === 0) pipelineBlockers.push('zero-denominator');
  if (input.retentionRows.length < 6 || !PHASE4_MODULE_IDS.every((moduleId) => retentionModules.has(moduleId))) pipelineBlockers.push('coverage-gap');
  if (!validAnchors) pipelineBlockers.push('comparison-anchor-failure');
  if (!completeRetention) pipelineBlockers.push('incomplete-evidence');
  if (!retentionReview.complete) pipelineBlockers.push('user-review-required');
  if (pipelineCleanRegression) pipelineBlockers.push('clean-regression');
  if ((pipelineInfrastructureRate.value ?? 0) > 0.05) pipelineBlockers.push('high-infrastructure-rate');
  if (!budget.passed) pipelineBlockers.push(budget.exhausted ? 'budget-exhausted' : 'budget-invalid');
  if (input.trust.status === 'repairable-failure') pipelineBlockers.push('repairable-trust-failure');

  return {
    schemaVersion: PHASE4_SCORER_VERSION,
    epochId: input.epochId,
    registrationStaticPolicyDigest: input.registrationStaticPolicyDigest,
    claims: {
      heldOutTemporalRows: 0,
      blindTemporalYield: 'not-applicable',
      blindTemporalYieldClaimAllowed: false,
      temporalGeneralizationClaimAllowed: false,
      absenceOfDefectsClaimAllowed: false,
    },
    counts: {
      fullMeasurementRows: input.measurementRows.length,
      metricEligibleTruths: eligibleGroups.size,
      frozenRetentionRows: input.retentionRows.length,
      acceptedSeeds: { G: input.acceptedSeedIds.G.length, P: input.acceptedSeedIds.P.length },
    },
    generation,
    operator,
    interpreterPipeline: {
      retention: retentionMetric,
      rows: retention,
      allAnchorsValid: validAnchors,
      complete: completeRetention,
      modules: sorted(retentionModules),
      infrastructureRate: pipelineInfrastructureRate,
    },
    overallInfrastructureRate: ratio(
      input.measurementRows.filter((row) => row.budget.charged && row.axes.execution === 'unrunnable').length,
      input.measurementRows.filter((row) => row.budget.charged).length,
    ),
    budget,
    verdicts: {
      generationProcedure: verdict(input, generationBlockers, generationAdopt, generationRetire),
      interpreterPipeline: verdict(input, pipelineBlockers, retentionMetric.value === 1, retentionMetric.status === 'applicable' && retentionMetric.value < 0.8),
      operatorStrategy: verdict(input, operatorBlockers, incremental.size >= 2, operatorRetireCoverage && incremental.size === 0),
    },
  };
}
