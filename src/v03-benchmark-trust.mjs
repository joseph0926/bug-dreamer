import {
  benchmarkPlanDigest,
  benchmarkSpecDigest,
  validateBenchmarkPlan,
  validateBenchmarkSpec,
} from './v03-benchmark-spec.mjs';
import { RESULT_DIGEST_DOMAIN, RESULT_SCHEMA_VERSION } from './v03-trust.mjs';
import { canonicalJson, domainDigest, parseJsonBytes, validateJsonValueLimits } from './v03-wire.mjs';

export const BENCHMARK_OBSERVATION_SCHEMAS = Object.freeze({
  'returned-value': Object.freeze([Object.freeze({ name: 'value', type: 'json' })]),
  'thrown-error': Object.freeze([
    Object.freeze({ name: 'name', type: 'string' }),
    Object.freeze({ name: 'message', type: 'string' }),
  ]),
});

export class V03BenchmarkTrustError extends Error {}

export { createBenchmarkTrustedResult } from './v03-benchmark-result.mjs';
export { EXECUTION_BUDGET, readTrustedResultChannel } from './v03-trust.mjs';

function fail(message) {
  throw new V03BenchmarkTrustError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function strictKeys(value, keys, label) {
  assert(isPlainObject(value), `${label} must be an object`);
  assert(canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()), `${label} fields changed`);
}

function validSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function validateObservedFields(value, registrations) {
  assert(isPlainObject(value), 'Trusted result observedFields must be an object');
  assert(canonicalJson(Object.keys(value).sort()) === canonicalJson(registrations.map((item) => item.name).sort()), 'Trusted result observedFields differ from the registered observation kind');
  for (const registration of registrations) {
    const observed = value[registration.name];
    if (registration.type === 'string') assert(typeof observed === 'string', `Observed field type mismatch: ${registration.name}`);
    else if (registration.type === 'json') validateJsonValueLimits(observed);
    else fail(`Unknown observed field type: ${registration.type}`);
  }
}

function payloadWithoutDigest(result) {
  const { payloadDigest, ...payload } = result;
  return payload;
}

export function validateBenchmarkTrustedResult(result, plan, spec, descriptor) {
  validateBenchmarkSpec(spec, descriptor);
  validateBenchmarkPlan(plan, spec, descriptor);
  strictKeys(result, ['schemaVersion', 'specDigest', 'planDigest', 'targetArtifactDigest', 'invariantRegistrationId', 'evaluatorStatus', 'execution', 'observedKind', 'observedFields', 'violationIdentity', 'payloadDigest'], 'Trusted result');
  assert(result.schemaVersion === RESULT_SCHEMA_VERSION, 'Unexpected trusted result schemaVersion');
  assert(result.specDigest === benchmarkSpecDigest(spec, descriptor), 'Trusted result specDigest mismatch');
  assert(result.planDigest === benchmarkPlanDigest(plan, spec, descriptor), 'Trusted result planDigest mismatch');
  assert(result.targetArtifactDigest === plan.targetArtifactDigest, 'Trusted result target artifact mismatch');
  assert(result.invariantRegistrationId === plan.invariantRegistrationId, 'Trusted result invariant mismatch');
  assert(result.evaluatorStatus === 'evaluated', 'Trusted result evaluator status is invalid');
  assert(['pass', 'candidate-failure'].includes(result.execution), 'Trusted result execution is invalid');
  const observationSchema = BENCHMARK_OBSERVATION_SCHEMAS[result.observedKind];
  assert(observationSchema !== undefined, 'Trusted result observed kind is not registered');
  assert(canonicalJson(plan.observedFields) === canonicalJson(BENCHMARK_OBSERVATION_SCHEMAS[plan.normalizedObservedKind]), 'Plan observed contract differs from the registered result schema');
  validateObservedFields(result.observedFields, observationSchema);
  assert(validSha(result.payloadDigest), 'Trusted result payload digest is invalid');
  assert(result.payloadDigest === domainDigest(RESULT_DIGEST_DOMAIN, payloadWithoutDigest(result)), 'Trusted result payload digest mismatch');
  if (result.execution === 'pass') {
    assert(result.observedKind === plan.normalizedObservedKind, 'Passing trusted result observed kind mismatch');
    assert(result.violationIdentity === null, 'Passing trusted result cannot contain a violation identity');
  } else {
    strictKeys(result.violationIdentity, ['invariantRegistrationId', 'normalizedObservedKind', 'normalizedObservedFields', 'targetArtifactDigest'], 'Violation identity');
    assert(result.violationIdentity.invariantRegistrationId === plan.invariantRegistrationId, 'Violation identity invariant mismatch');
    assert(result.violationIdentity.normalizedObservedKind === result.observedKind, 'Violation identity observed kind mismatch');
    assert(canonicalJson(result.violationIdentity.normalizedObservedFields) === canonicalJson(result.observedFields), 'Violation identity observed fields mismatch');
    assert(result.violationIdentity.targetArtifactDigest === plan.targetArtifactDigest, 'Violation identity target artifact mismatch');
  }
  return result;
}

function unrunnable(reason) {
  return { status: 'unrunnable', reason, result: null };
}

export function classifyBenchmarkTrustedResult({
  resultBytes,
  exitCode,
  timedOut = false,
  outputTruncated = false,
  plan,
  spec,
  descriptor,
}) {
  if (timedOut === true) return unrunnable('evaluator-timeout');
  if (outputTruncated === true) return unrunnable('evaluator-log-limit');
  if (exitCode !== 0) return unrunnable('evaluator-early-exit');
  if (resultBytes === null || resultBytes === undefined) return unrunnable('missing-trusted-result');
  try {
    const result = validateBenchmarkTrustedResult(parseJsonBytes(resultBytes), plan, spec, descriptor);
    return { status: result.execution, reason: null, result };
  } catch (error) {
    return unrunnable(`malformed-trusted-result:${error.message}`);
  }
}
