import { buildTransformedSpec, REQUEST_SCHEMA_VERSION } from './v03-operators.mjs';
import { validateRunRecord } from './v03-run-record.mjs';
import { V03SpecError, buildExecutionPlan, buildNightmareSpec, planDigest, specDigest } from './v03-spec.mjs';
import { classifyTrustedResult } from './v03-trust.mjs';
import { V03WireError, canonicalJson, domainDigest } from './v03-wire.mjs';

export const RULE_ORDER = Object.freeze(['actor', 'action', 'binding', 'schedule-control', 'fault', 'fixture']);
export class ReductionError extends Error {}
class ReductionBlocked extends Error {}

function assert(condition, message) {
  if (!condition) throw new ReductionError(message);
}

const actionId = (index) => `action-${String(index + 1).padStart(4, '0')}`;
export const reductionInputDigest = (input) => domainDigest('bug-dreamer/reduction-input/v1', input);

export function buildReductionSpec(input, catalog, operatorCatalog) {
  assert(canonicalJson(Object.keys(input).sort()) === canonicalJson(['request', 'seed']), 'Reduction input fields changed');
  assert(canonicalJson(Object.keys(input.request).sort()) === canonicalJson(['schemaVersion', 'transformations']), 'Reduction request fields changed');
  assert(input.request.schemaVersion === REQUEST_SCHEMA_VERSION && Array.isArray(input.request.transformations), 'Reduction request is invalid');
  // An empty remaining chain denotes identity, without admitting empty generator requests.
  return input.request.transformations.length === 0
    ? buildNightmareSpec(input.seed, catalog)
    : buildTransformedSpec(input.seed, input.request, catalog, operatorCatalog);
}

export function reductionSelectors(input) {
  const { seed, request } = input;
  return [
    ...seed.actors.map((id) => ({ kind: 'actor', id })),
    ...seed.actions.map((_, index) => ({ kind: 'action', id: actionId(index) })),
    ...seed.actions.filter((action) => action.bind !== null).map((action) => ({ kind: 'binding', id: action.bind.name })),
    ...request.transformations.flatMap((entry, index) => entry.operatorId === 'fault.step-outcome/v1' ? [] : [{ kind: 'schedule-control', index }]),
    ...request.transformations.flatMap((entry, index) => entry.operatorId === 'fault.step-outcome/v1' ? [{ kind: 'fault', index }] : []),
    ...seed.actions.flatMap((action, index) => action.actionId === 'tx.run' ? [{ kind: 'fixture', id: actionId(index) }] : []),
  ];
}

function operatorReferences(entry) {
  if (entry.operatorId === 'time.advance/v1') return [entry.arguments.afterInstanceId];
  if (entry.operatorId === 'schedule.release-order/v1') return entry.arguments.instanceIds;
  if (entry.operatorId === 'fault.step-outcome/v1') return [entry.arguments.targetInstanceId];
  throw new ReductionError(`Unregistered reduction operator: ${entry.operatorId}`);
}

export function removeDependencyClosure(input, selector) {
  assert(reductionSelectors(input).some((entry) => canonicalJson(entry) === canonicalJson(selector)), 'Unknown reduction selector');
  const { seed, request } = input;
  const removed = new Set();
  const removedRequests = new Set();
  for (const [index, action] of seed.actions.entries()) {
    if ((selector.kind === 'actor' && action.actor === selector.id)
      || (['action', 'fixture'].includes(selector.kind) && actionId(index) === selector.id)
      || (selector.kind === 'binding' && action.bind?.name === selector.id)) removed.add(actionId(index));
  }
  if (['schedule-control', 'fault'].includes(selector.kind)) removedRequests.add(selector.index);
  let changed;
  do {
    changed = false;
    const bindings = new Set(seed.actions.filter((_, index) => removed.has(actionId(index))).flatMap((action) => action.bind === null ? [] : [action.bind.name]));
    for (const [index, action] of seed.actions.entries()) {
      // Only registered tx-handle argument positions are edges; payload values are data.
      if (['tx.run', 'tx.commit'].includes(action.actionId) && bindings.has(action.arguments.tx.$binding) && !removed.has(actionId(index))) {
        removed.add(actionId(index));
        changed = true;
      }
    }
  } while (changed);
  request.transformations.forEach((entry, index) => {
    if (operatorReferences(entry).some((id) => removed.has(id))) removedRequests.add(index);
  });
  const idMap = new Map();
  const actions = seed.actions.filter((_, index) => {
    if (removed.has(actionId(index))) return false;
    idMap.set(actionId(index), actionId(idMap.size));
    return true;
  });
  const actors = seed.actors.filter((id) => !(selector.kind === 'actor' && selector.id === id) && actions.some((action) => action.actor === id));
  const transformations = request.transformations.flatMap((entry, index) => {
    if (removedRequests.has(index)) return [];
    const next = structuredClone(entry);
    if (entry.operatorId === 'time.advance/v1') next.arguments.afterInstanceId = idMap.get(entry.arguments.afterInstanceId);
    else if (entry.operatorId === 'fault.step-outcome/v1') next.arguments.targetInstanceId = idMap.get(entry.arguments.targetInstanceId);
    else next.arguments.instanceIds = entry.arguments.instanceIds.map((id) => idMap.get(id));
    return [next];
  });
  return {
    input: structuredClone({ seed: { ...seed, actors, actions }, request: { ...request, transformations } }),
    removed: {
      actors: seed.actors.filter((id) => !actors.includes(id)),
      actions: seed.actions.flatMap((_, index) => removed.has(actionId(index)) ? [actionId(index)] : []),
      bindings: seed.actions.flatMap((action, index) => removed.has(actionId(index)) && action.bind !== null ? [action.bind.name] : []),
      transformations: [...removedRequests].sort((left, right) => left - right),
      fixtures: seed.actions.flatMap((action, index) => removed.has(actionId(index)) && action.actionId === 'tx.run' ? [actionId(index)] : []),
    },
  };
}

function prepare(input, catalog, operatorCatalog) {
  const spec = buildReductionSpec(input, catalog, operatorCatalog);
  const plan = buildExecutionPlan(spec, catalog);
  return { spec, plan, specDigest: specDigest(spec, catalog), planDigest: planDigest(plan, spec, catalog) };
}

export function recomputeReductionRun(record, prepared, catalog) {
  validateRunRecord(record, { assert, label: 'Reduction run' });
  const classification = classifyTrustedResult({
    resultBytes: record.rawResult === null ? null : Buffer.from(record.rawResult),
    exitCode: record.exitCode,
    timedOut: record.timedOut,
    outputTruncated: record.outputTruncated,
    plan: prepared.plan,
    spec: prepared.spec,
    catalog,
  });
  assert(canonicalJson(classification) === canonicalJson(record.classification), 'Reduction run classification mismatch');
  return classification;
}

export async function reduceSpec({ input, cleanCatalog, defectCatalog, operatorCatalog, expectedIdentity, registration, evaluate }) {
  let current = structuredClone(input);
  let prepared = prepare(current, defectCatalog, operatorCatalog);
  const initialSpecDigest = prepared.specDigest;
  const attempts = [];
  const runs = [];
  let acceptedRemovals = 0;
  let validAttempts = 0;
  let blocker = null;
  const identityKey = canonicalJson(expectedIdentity);
  assert(expectedIdentity !== null, 'Reduction requires a violation identity');

  const execute = async (candidate, artifact, phase) => {
    if (runs.length >= registration.maxEvaluations) throw new ReductionBlocked('evaluation-budget-exhausted');
    const catalog = artifact === 'clean' ? cleanCatalog : defectCatalog;
    const descriptor = { index: runs.length, phase, artifact, specDigest: candidate.specDigest, planDigest: candidate.planDigest };
    const record = await evaluate({ ...descriptor, spec: candidate.spec, plan: candidate.plan, catalog });
    runs.push({ ...descriptor, record });
    if (record.cleanupError !== null) throw new ReductionBlocked('container-cleanup-failed');
    const classification = recomputeReductionRun(record, candidate, catalog);
    if (classification.execution.status === 'unrunnable') throw new ReductionBlocked('unrunnable');
    return { index: descriptor.index, classification };
  };
  const preserves = (classification) => classification.execution.status === 'candidate-failure'
    && classification.violationIdentity !== null && canonicalJson(classification.violationIdentity) === identityKey;
  try {
    const initial = await execute(prepared, 'defect', 'initial');
    if (!preserves(initial.classification)) throw new ReductionBlocked('initial-violation-mismatch');
    for (;;) {
      let accepted = false;
      for (const selector of reductionSelectors(current)) {
        if (attempts.length >= registration.maxCandidateAttempts) throw new ReductionBlocked('candidate-budget-exhausted');
        const candidate = removeDependencyClosure(current, selector);
        const attempt = {
          selector, removed: candidate.removed,
          beforeDigest: reductionInputDigest(current), candidateDigest: reductionInputDigest(candidate.input),
        };
        let next;
        try {
          next = prepare(candidate.input, defectCatalog, operatorCatalog);
        } catch (error) {
          if (!(error instanceof V03SpecError || error instanceof V03WireError)) throw error;
          attempts.push({ ...attempt, status: 'invalid', rejection: { kind: error instanceof V03SpecError ? error.kind : 'rejected-schema', message: error.message } });
          continue;
        }
        validAttempts += 1;
        let outcome;
        const runIndex = runs.length;
        try {
          outcome = await execute(next, 'defect', 'candidate');
        } catch (error) {
          if (error instanceof ReductionBlocked) attempts.push({ ...attempt, status: 'blocked', runIndex: runs.length > runIndex ? runIndex : null, reason: error.message });
          throw error;
        }
        accepted = preserves(outcome.classification);
        attempts.push({ ...attempt, status: 'executed', runIndex: outcome.index, preserved: accepted });
        if (accepted) {
          current = candidate.input;
          prepared = next;
          acceptedRemovals += 1;
          break;
        }
      }
      if (!accepted) break;
    }
    const clean = await execute(prepare(current, cleanCatalog, operatorCatalog), 'clean', 'clean-check');
    if (clean.classification.execution.status !== 'pass') throw new ReductionBlocked('clean-check-failed');
    for (let index = 0; index < registration.replayRuns; index += 1) {
      const replay = await execute(prepared, 'defect', 'replay');
      if (!preserves(replay.classification)) throw new ReductionBlocked('replay-violation-mismatch');
    }
  } catch (error) {
    if (!(error instanceof ReductionBlocked)) throw error;
    blocker = error.message;
  }
  return {
    status: blocker === null ? 'one-minimal' : 'reduced-not-one-minimal', blocker,
    initialSpecDigest, violationIdentity: expectedIdentity,
    attempts, runs,
    final: { input: current, ...prepared },
    counts: { candidateAttempts: attempts.length, validAttempts, invalidAttempts: attempts.filter((attempt) => attempt.status === 'invalid').length, acceptedRemovals, evaluations: runs.length },
  };
}
