import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PHASE4_APPROVED_STATIC_POLICY_DIGEST,
  phase4ViolationIdentityDigest,
} from '../src/v03-benchmark-contract.mjs';
import {
  PHASE4_SCORER_VERSION,
  V03BenchmarkScoreError,
  scorePhase4Benchmark,
} from '../src/v03-benchmark-score.mjs';

const EPOCH = 'a'.repeat(64);
const POLICY = PHASE4_APPROVED_STATIC_POLICY_DIGEST;
const RESULT = 'c'.repeat(64);
const SPEC = 'd'.repeat(64);
const PLAN = 'e'.repeat(64);
const TARGET = 'f'.repeat(64);
const CLEAN_TARGET = '0'.repeat(64);
const MODULES = ['tx', 'local-first', 'prepaint'];
const TRUTHS = [
  { id: 'tx-one', moduleId: 'tx' },
  { id: 'tx-two', moduleId: 'tx' },
  { id: 'local-first-one', moduleId: 'local-first' },
  { id: 'local-first-two', moduleId: 'local-first' },
  { id: 'prepaint-one', moduleId: 'prepaint' },
  { id: 'prepaint-two', moduleId: 'prepaint' },
];

const fixture = JSON.parse(await readFile(new URL('../contracts/v0.3/benchmark-score-cases.json', import.meta.url)));

function invariantId(truthId) {
  return `invariant.${truthId}`;
}

function identity(truthId, normalizedObservedFields = { truthId, execution: 'candidate-failure' }, targetArtifactDigest = TARGET) {
  return phase4ViolationIdentityDigest({
    invariantRegistrationId: invariantId(truthId),
    normalizedObservedKind: 'returned-value',
    normalizedObservedFields,
    targetArtifactDigest,
  });
}

function observation(execution, truthId, overrideIdentity, targetArtifactDigest = TARGET) {
  if (!['pass', 'candidate-failure'].includes(execution)) return null;
  return {
    normalizedObservedKind: 'returned-value',
    normalizedObservedFields: { truthId, execution },
    violationIdentity: execution === 'candidate-failure' ? (overrideIdentity ?? identity(truthId, undefined, targetArtifactDigest)) : null,
    resultPayloadDigest: RESULT,
  };
}

function makeBase() {
  let sequence = 0;
  let evaluationOrdinal = 0;
  const rows = [];
  const candidates = [];
  const requests = [];
  const groups = new Map(TRUTHS.map(({ id }) => [id, id]));

  function addRow({ armId, moduleId, inputId, truthId, artifactRole, phase = 'initial', replayIndex = null, execution = 'pass', executionPath = armId === 'D' ? 'comparison' : 'interpreter', charged = true, reasonCode = null, overrideIdentity }) {
    if (charged) evaluationOrdinal += 1;
    const targetArtifactDigest = artifactRole === 'clean' ? CLEAN_TARGET : TARGET;
    rows.push({
      schemaVersion: 'bug-dreamer/v03-benchmark-measurement-row/v1',
      epochId: EPOCH,
      sequence: sequence++,
      armId,
      moduleId,
      inputId,
      canonicalTruthId: truthId,
      duplicateGroup: groups.get(truthId),
      artifactRole,
      targetArtifactDigest,
      phase,
      replayIndex,
      executionPath,
      specDigest: execution === 'not-run' ? null : SPEC,
      planDigest: execution === 'not-run' ? null : PLAN,
      runRecordRef: charged ? `evidence/v0.3/phase4/runs/${sequence}.json` : null,
      axes: {
        specAcceptance: 'accepted',
        plan: execution === 'not-run' ? 'not-run' : 'planned',
        evaluator: execution === 'not-run' ? 'not-run' : (execution === 'unrunnable' ? 'evaluator-error' : 'evaluated'),
        execution,
      },
      observation: observation(execution, truthId, overrideIdentity, targetArtifactDigest),
      reasonCode,
      budget: { charged, evaluationOrdinal: charged ? evaluationOrdinal : null },
    });
  }

  function addPair(armId, inputId, truth, caught, overrideIdentity) {
    addRow({ armId, moduleId: truth.moduleId, inputId, truthId: truth.id, artifactRole: 'clean', execution: 'pass' });
    addRow({ armId, moduleId: truth.moduleId, inputId, truthId: truth.id, artifactRole: 'single-patch-defect', execution: caught ? 'candidate-failure' : 'pass', overrideIdentity });
  }

  function addCandidate(armId, inputId, truth, overrideIdentity) {
    candidates.push({ armId, inputId, canonicalTruthId: truth.id, started: true, expectedRuns: 5 });
    for (let replayIndex = 1; replayIndex <= 5; replayIndex += 1) {
      addRow({ armId, moduleId: truth.moduleId, inputId, truthId: truth.id, artifactRole: 'single-patch-defect', phase: 'replay', replayIndex, execution: 'candidate-failure', overrideIdentity });
    }
  }

  const acceptedSeedIds = { G: [], P: [] };
  for (const armId of ['G', 'P']) {
    for (const moduleId of MODULES) {
      const inputId = `${armId.toLowerCase()}-${moduleId}`;
      acceptedSeedIds[armId].push(inputId);
      for (const truth of TRUTHS.filter((item) => item.moduleId === moduleId)) {
        const caught = truth.id.endsWith('-one') && (armId === 'P' || truth.moduleId !== 'prepaint');
        addPair(armId, inputId, truth, caught);
        if (caught && !(armId === 'P' && truth.moduleId === 'prepaint')) addCandidate(armId, inputId, truth);
      }
    }
  }

  const requestCoordinates = [
    ['A', 'p-tx', 'tx'], ['A', 'p-local-first', 'local-first'], ['A', 'p-prepaint', 'prepaint'],
    ['B', 'p-tx', 'tx'], ['B', 'p-local-first', 'local-first'], ['B', 'p-prepaint', 'prepaint'],
    ['C', 'p-tx', 'tx'], ['C', 'p-local-first', 'local-first'], ['C', 'p-prepaint', 'prepaint'],
  ];
  for (const [armId, inputId, moduleId] of requestCoordinates) {
    requests.push({ requestId: `${armId.toLowerCase()}-${moduleId}-request`, inputId, armId, moduleId, applicable: true, reasonCode: null });
    for (const truth of TRUTHS.filter((item) => item.moduleId === moduleId)) {
      const caught = armId === 'A' && ['tx-two', 'local-first-two'].includes(truth.id);
      addPair(armId, inputId, truth, caught);
      if (caught) addCandidate(armId, inputId, truth);
    }
  }

  const retentionRows = [];
  for (const truth of TRUTHS) {
    const rowId = `retention-${truth.id}`;
    retentionRows.push({ rowId, moduleId: truth.moduleId, canonicalTruthId: truth.id, duplicateGroup: truth.id });
    addPair('D', rowId, truth, true);
    addPair('E', rowId, truth, true);
    addCandidate('E', rowId, truth);
  }

  const input = {
    epochId: EPOCH,
    registrationStaticPolicyDigest: POLICY,
    metricEligibleTruthIds: TRUTHS.map(({ id }) => id),
    truthCommitments: TRUTHS.map(({ id, moduleId }) => ({
      canonicalTruthId: id,
      moduleId,
      duplicateGroup: id,
      invariantRegistrationId: invariantId(id),
      matcherId: `matcher.${id}`,
      expected: {
        normalizedObservedKind: 'returned-value',
        normalizedObservedFields: { truthId: id, execution: 'candidate-failure' },
      },
    })),
    retentionRows,
    acceptedSeedIds,
    operatorRequests: requests,
    replayCandidates: candidates,
    measurementRows: rows,
    userReviews: TRUTHS.map(({ id }, index) => ({ canonicalTruthId: id, verdict: index % 2 === 0 ? 'real-bug-worth-fixing' : 'real-bug-not-worth-fixing' })),
    trust: { status: 'pass', reasonCode: null },
    epochAbort: null,
    budgetLedger: null,
  };
  refreshLedger(input);
  return input;
}

function refreshLedger(input, stoppedBy = input.budgetLedger?.stoppedBy ?? null) {
  const charged = input.measurementRows.filter((row) => row.budget.charged);
  charged.forEach((row, index) => { row.budget.evaluationOrdinal = index + 1; });
  input.measurementRows.forEach((row, index) => { row.sequence = index; });
  input.budgetLedger = {
    schemaVersion: 'bug-dreamer/v03-benchmark-budget-ledger/v1',
    epochId: EPOCH,
    generation: {
      freshSessions: 2,
      submittedTaskTurns: 2,
      emittedSeeds: 6,
      acceptedSeeds: input.acceptedSeedIds.G.length + input.acceptedSeedIds.P.length,
      operatorRequests: input.operatorRequests.length,
      transformedSpecs: input.operatorRequests.filter((request) => request.applicable).length,
    },
    measurement: {
      dockerEvaluations: charged.length,
      replayCandidates: input.replayCandidates.filter((candidate) => candidate.started).length,
      replayRuns: charged.filter((row) => row.phase === 'replay').length,
      elapsedSeconds: charged.length,
    },
    preparation: { builds: 24, inspects: 60, probeContainers: 12, failures: 0, cleanups: 24, cleanupFailures: 0, elapsedSeconds: 7200 },
    stoppedBy,
  };
}

function rowOf(input, armId, truthId, artifactRole, phase = 'initial', replayIndex = null) {
  return input.measurementRows.find((row) => row.armId === armId && row.canonicalTruthId === truthId && row.artifactRole === artifactRole && row.phase === phase && row.replayIndex === replayIndex);
}

function setExecution(row, execution, overrideIdentity) {
  row.axes.execution = execution;
  row.axes.evaluator = execution === 'unrunnable' ? 'evaluator-error' : 'evaluated';
  row.observation = observation(execution, row.canonicalTruthId, overrideIdentity, row.targetArtifactDigest);
}

test('the checked-in cases enumerate every approved scoring boundary', () => {
  assert.equal(fixture.schemaVersion, 'bug-dreamer/v03-benchmark-score-cases/v1');
  assert.equal(fixture.cases.length, 15);
  assert.deepEqual(new Set(fixture.cases.map((item) => item.id)).size, fixture.cases.length);
});

test('raw two-sided candidates and five separate replay confirmations are distinct', () => {
  const input = makeBase();
  setExecution(rowOf(input, 'G', 'prepaint-two', 'single-patch-defect'), 'candidate-failure');
  const score = scorePhase4Benchmark(input);
  assert.equal(score.schemaVersion, PHASE4_SCORER_VERSION);
  assert.equal(score.generation.G.rawTwoSidedCandidateRate.numerator, 3);
  assert.equal(score.generation.G.replayConfirmedCatchRate.numerator, 2);
  assert.equal(score.generation.G.fiveOfFiveRate.numerator, 2);
  assert.equal(score.generation.G.fiveOfFiveRate.denominator, 2);
});

test('a different normalized violation identity is neither a raw nor replay-confirmed catch', () => {
  const initialMismatch = makeBase();
  const initialRow = rowOf(initialMismatch, 'G', 'tx-one', 'single-patch-defect');
  initialRow.observation.normalizedObservedFields = { truthId: 'tx-one', execution: 'candidate-failure', manifestation: 'different' };
  initialRow.observation.violationIdentity = identity('tx-one', initialRow.observation.normalizedObservedFields);
  const initialScore = scorePhase4Benchmark(initialMismatch);
  assert.equal(initialScore.generation.G.rawTwoSidedCandidateRate.numerator, 1);
  assert.equal(initialScore.generation.G.replayConfirmedCatchRate.numerator, 1);

  const replayMismatch = makeBase();
  const replayRow = rowOf(replayMismatch, 'G', 'tx-one', 'single-patch-defect', 'replay', 3);
  replayRow.observation.normalizedObservedFields = { truthId: 'tx-one', execution: 'candidate-failure', manifestation: 'different' };
  replayRow.observation.violationIdentity = identity('tx-one', replayRow.observation.normalizedObservedFields);
  const replayScore = scorePhase4Benchmark(replayMismatch);
  assert.equal(replayScore.generation.G.rawTwoSidedCandidateRate.numerator, 2);
  assert.equal(replayScore.generation.G.replayConfirmedCatchRate.numerator, 1);
});

test('canonical duplicate groups count once', () => {
  const input = makeBase();
  for (const row of input.measurementRows.filter((item) => item.canonicalTruthId === 'tx-two')) row.duplicateGroup = 'tx-one';
  input.retentionRows.find((item) => item.canonicalTruthId === 'tx-two').duplicateGroup = 'tx-one';
  input.truthCommitments.find((item) => item.canonicalTruthId === 'tx-two').duplicateGroup = 'tx-one';
  input.userReviews.find((item) => item.canonicalTruthId === 'tx-two').verdict = input.userReviews.find((item) => item.canonicalTruthId === 'tx-one').verdict;
  setExecution(rowOf(input, 'G', 'tx-two', 'single-patch-defect'), 'candidate-failure');
  const score = scorePhase4Benchmark(input);
  assert.equal(score.counts.metricEligibleTruths, 5);
  assert.equal(score.generation.G.rawTwoSidedCandidateRate.numerator, 2);
});

test('wrong expectation is counted while undecided blocks dependent metrics', () => {
  const input = makeBase();
  input.userReviews.find((item) => item.canonicalTruthId === 'tx-one').verdict = 'wrong-expectation';
  input.userReviews.find((item) => item.canonicalTruthId === 'local-first-one').verdict = 'undecided';
  const score = scorePhase4Benchmark(input);
  assert.equal(score.generation.G.falseOracleRate.status, 'blocked');
  assert.equal(score.generation.G.falseOracleRate.numerator, 1);
  assert.equal(score.verdicts.generationProcedure.verdict, 'revise');
  assert(score.verdicts.generationProcedure.reasons.includes('user-review-required'));
});

test('zero denominators are not-applicable and empty held-out membership forbids blind claims', () => {
  const input = makeBase();
  input.metricEligibleTruthIds = [];
  input.acceptedSeedIds = { G: [], P: [] };
  input.operatorRequests = [];
  input.replayCandidates = [];
  input.retentionRows = [];
  input.measurementRows = [];
  input.userReviews = [];
  refreshLedger(input);
  const score = scorePhase4Benchmark(input);
  assert.equal(score.generation.G.rawTwoSidedCandidateRate.status, 'not-applicable');
  assert.equal(score.operator.applicabilityRate.status, 'not-applicable');
  assert.equal(score.interpreterPipeline.retention.status, 'not-applicable');
  assert.equal(score.claims.blindTemporalYield, 'not-applicable');
  assert.equal(score.claims.blindTemporalYieldClaimAllowed, false);
});

test('development and other non-eligible rows cannot influence adoption', () => {
  const input = makeBase();
  input.metricEligibleTruthIds = input.metricEligibleTruthIds.filter((truthId) => truthId !== 'prepaint-two');
  setExecution(rowOf(input, 'G', 'prepaint-two', 'clean'), 'candidate-failure');
  assert.equal(scorePhase4Benchmark(input).verdicts.generationProcedure.verdict, 'adopt');

  const development = makeBase();
  development.metricEligibleTruthIds.push('tx-total-timeout-resets-per-step');
  assert.throws(() => scorePhase4Benchmark(development), /Development truth/u);
});

test('E loss remains in the fixed denominator and D anchor failure blocks adoption', () => {
  const retentionLoss = makeBase();
  setExecution(rowOf(retentionLoss, 'E', 'tx-one', 'single-patch-defect', 'replay', 1), 'unrunnable');
  const lossScore = scorePhase4Benchmark(retentionLoss);
  assert.equal(lossScore.interpreterPipeline.retention.denominator, 6);
  assert.equal(lossScore.interpreterPipeline.retention.numerator, 5);

  const anchorFailure = makeBase();
  const anchorRow = rowOf(anchorFailure, 'D', 'tx-one', 'single-patch-defect');
  anchorRow.observation.normalizedObservedFields = { truthId: 'tx-one', execution: 'candidate-failure', manifestation: 'different' };
  anchorRow.observation.violationIdentity = identity('tx-one', anchorRow.observation.normalizedObservedFields);
  const anchorScore = scorePhase4Benchmark(anchorFailure);
  assert.equal(anchorScore.interpreterPipeline.retention.denominator, 6);
  assert.equal(anchorScore.verdicts.interpreterPipeline.verdict, 'revise');
  assert(anchorScore.verdicts.interpreterPipeline.reasons.includes('comparison-anchor-failure'));
});

test('all complete P raw catches, including catches outside replay quota, are operator baseline', () => {
  const input = makeBase();
  setExecution(rowOf(input, 'P', 'tx-two', 'single-patch-defect'), 'candidate-failure');
  const score = scorePhase4Benchmark(input);
  assert(score.operator.pCompleteRawBaselineTruthIds.includes('tx-two'));
  assert(!score.operator.incrementalTruthIds.includes('tx-two'));
  assert.deepEqual(score.operator.incrementalTruthIds, ['local-first-two']);
});

test('incomplete P evidence blocks operator incrementality verdict', () => {
  const input = makeBase();
  setExecution(rowOf(input, 'P', 'tx-two', 'single-patch-defect'), 'unrunnable');
  const score = scorePhase4Benchmark(input);
  assert.equal(score.verdicts.operatorStrategy.verdict, 'revise');
  assert(score.verdicts.operatorStrategy.reasons.includes('incomplete-p-baseline'));
});

test('pipeline adopts only perfect complete six-row three-module retention', () => {
  const score = scorePhase4Benchmark(makeBase());
  assert.equal(score.interpreterPipeline.retention.value, 1);
  assert.deepEqual(score.interpreterPipeline.modules, MODULES.slice().sort());
  assert.equal(score.verdicts.interpreterPipeline.verdict, 'adopt');
});

test('pipeline retires on complete counterevidence below 0.8', () => {
  const input = makeBase();
  for (const truthId of ['tx-one', 'local-first-one']) {
    setExecution(rowOf(input, 'E', truthId, 'single-patch-defect'), 'pass');
    for (let replayIndex = 1; replayIndex <= 5; replayIndex += 1) setExecution(rowOf(input, 'E', truthId, 'single-patch-defect', 'replay', replayIndex), 'pass');
  }
  const score = scorePhase4Benchmark(input);
  assert.equal(score.interpreterPipeline.complete, true);
  assert.equal(score.interpreterPipeline.retention.value, 4 / 6);
  assert.equal(score.verdicts.interpreterPipeline.verdict, 'retire');
  assert.equal(score.verdicts.interpreterPipeline.branch, 'sufficient-counterevidence-retire');
});

test('operator adopts with two new confirmed IDs and retires only with six complete specs and module coverage', () => {
  const adopt = scorePhase4Benchmark(makeBase());
  assert.equal(adopt.operator.incrementalYield, 2);
  assert.equal(adopt.verdicts.operatorStrategy.verdict, 'adopt');

  const retireInput = makeBase();
  for (const truthId of ['tx-two', 'local-first-two']) {
    setExecution(rowOf(retireInput, 'A', truthId, 'single-patch-defect'), 'pass');
    for (let replayIndex = 1; replayIndex <= 5; replayIndex += 1) setExecution(rowOf(retireInput, 'A', truthId, 'single-patch-defect', 'replay', replayIndex), 'pass');
  }
  const retire = scorePhase4Benchmark(retireInput);
  assert.equal(retire.operator.completeApplicableSpecCount, 9);
  assert.deepEqual(retire.operator.completeApplicableModules, MODULES.slice().sort());
  assert.equal(retire.operator.incrementalYield, 0);
  assert.equal(retire.verdicts.operatorStrategy.verdict, 'retire');
});

test('first-match verdict order is abort, trust retire, revise, adopt, counterevidence retire, otherwise revise', () => {
  const abortInput = makeBase();
  abortInput.epochAbort = { reasonCode: 'sealed-ref-mismatch', sequence: 1 };
  abortInput.trust = { status: 'non-repairable-failure', reasonCode: 'forged-result' };
  assert.equal(scorePhase4Benchmark(abortInput).verdicts.generationProcedure.verdict, 'abort');

  const trustInput = makeBase();
  trustInput.trust = { status: 'non-repairable-failure', reasonCode: 'forged-result' };
  trustInput.budgetLedger.stoppedBy = 'budget-exhausted';
  assert.equal(scorePhase4Benchmark(trustInput).verdicts.generationProcedure.verdict, 'retire');

  const repairableInput = makeBase();
  repairableInput.trust = { status: 'repairable-failure', reasonCode: 'reviewable-contract-gap' };
  assert.equal(scorePhase4Benchmark(repairableInput).verdicts.generationProcedure.verdict, 'revise');

  assert.equal(scorePhase4Benchmark(makeBase()).verdicts.generationProcedure.verdict, 'adopt');

  const budgetInput = makeBase();
  budgetInput.budgetLedger.stoppedBy = 'budget-exhausted';
  const budgetVerdict = scorePhase4Benchmark(budgetInput).verdicts.generationProcedure;
  assert.equal(budgetVerdict.verdict, 'revise');
  assert(budgetVerdict.reasons.includes('budget-exhausted'));

  const cleanInput = makeBase();
  setExecution(rowOf(cleanInput, 'G', 'tx-two', 'clean'), 'candidate-failure');
  const cleanVerdict = scorePhase4Benchmark(cleanInput).verdicts.generationProcedure;
  assert.equal(cleanVerdict.verdict, 'revise');
  assert(cleanVerdict.reasons.includes('clean-regression'));

  const infrastructureInput = makeBase();
  setExecution(rowOf(infrastructureInput, 'G', 'tx-two', 'single-patch-defect'), 'unrunnable');
  setExecution(rowOf(infrastructureInput, 'G', 'prepaint-two', 'single-patch-defect'), 'unrunnable');
  const infrastructureVerdict = scorePhase4Benchmark(infrastructureInput).verdicts.generationProcedure;
  assert.equal(infrastructureVerdict.verdict, 'revise');
  assert(infrastructureVerdict.reasons.includes('high-infrastructure-rate'));

  const retireInput = makeBase();
  setExecution(rowOf(retireInput, 'P', 'tx-one', 'single-patch-defect'), 'pass');
  setExecution(rowOf(retireInput, 'P', 'prepaint-one', 'single-patch-defect'), 'pass');
  for (let replayIndex = 1; replayIndex <= 5; replayIndex += 1) setExecution(rowOf(retireInput, 'P', 'tx-one', 'single-patch-defect', 'replay', replayIndex), 'pass');
  retireInput.userReviews.find((item) => item.canonicalTruthId === 'local-first-one').verdict = 'wrong-expectation';
  assert.equal(scorePhase4Benchmark(retireInput).verdicts.generationProcedure.verdict, 'retire');

  const otherwiseInput = makeBase();
  for (let replayIndex = 1; replayIndex <= 5; replayIndex += 1) setExecution(rowOf(otherwiseInput, 'P', 'tx-one', 'single-patch-defect', 'replay', replayIndex), 'pass');
  assert.equal(scorePhase4Benchmark(otherwiseInput).verdicts.generationProcedure.verdict, 'revise');
  assert.equal(scorePhase4Benchmark(otherwiseInput).verdicts.generationProcedure.branch, 'otherwise-revise');
});

test('budget output fixes measurement and separate preparation limits', () => {
  const score = scorePhase4Benchmark(makeBase());
  assert.equal(score.budget.utilization.dockerEvaluations.denominator, 460);
  assert.equal(score.budget.utilization.timeoutSeconds.denominator, 13800);
  assert.equal(score.budget.utilization.preparationBuilds.denominator, 24);
  assert.equal(score.budget.utilization.preparationInspectOrProbe.denominator, 72);
  assert.equal(score.budget.utilization.preparationFailures.denominator, 0);
  assert.equal(score.budget.utilization.preparationWallClockSeconds.denominator, 7200);
  assert.equal(score.budget.utilization.measurementWallClockSeconds.denominator, 18000);
});

test('caller-claimed score fields and malformed ledgers are rejected', () => {
  const claimed = { ...makeBase(), claimedScore: { verdict: 'adopt' } };
  assert.throws(() => scorePhase4Benchmark(claimed), V03BenchmarkScoreError);

  const malformed = makeBase();
  malformed.budgetLedger.measurement.dockerEvaluations -= 1;
  assert.throws(() => scorePhase4Benchmark(malformed), /ledger disagrees/u);

  const reusedInitial = makeBase();
  const initial = rowOf(reusedInitial, 'G', 'tx-one', 'single-patch-defect');
  rowOf(reusedInitial, 'G', 'tx-one', 'single-patch-defect', 'replay', 1).runRecordRef = initial.runRecordRef;
  assert.throws(() => scorePhase4Benchmark(reusedInitial), /initial observation run/u);

  const forgedIdentity = makeBase();
  rowOf(forgedIdentity, 'G', 'tx-one', 'single-patch-defect').observation.violationIdentity = '9'.repeat(64);
  assert.throws(() => scorePhase4Benchmark(forgedIdentity), /disagrees with the normalized observation/u);
});

test('scoring is pure and byte-for-byte deterministic for the same normalized source facts', () => {
  const input = makeBase();
  const before = structuredClone(input);
  const first = scorePhase4Benchmark(input);
  const second = scorePhase4Benchmark(input);
  assert.deepEqual(input, before);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});
