import { canonicalJson, domainDigest, validateJsonValueLimits } from './v03-wire.mjs';

export const BENCHMARK_RESULT_SCHEMA_VERSION = 'bug-dreamer/trusted-result/v1';
export const BENCHMARK_RESULT_DIGEST_DOMAIN = 'bug-dreamer/trusted-result/v1';

function fail(message) {
  throw new TypeError(message);
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

function validateObservation(kind, fields) {
  assert(['returned-value', 'thrown-error'].includes(kind), 'Oracle evaluation observedKind is invalid');
  if (kind === 'returned-value') {
    strictKeys(fields, ['value'], 'Oracle returned-value fields');
    validateJsonValueLimits(fields.value);
  } else {
    strictKeys(fields, ['name', 'message'], 'Oracle thrown-error fields');
    assert(typeof fields.name === 'string' && typeof fields.message === 'string', 'Oracle thrown-error fields must be strings');
  }
}

export function createBenchmarkTrustedResult(metadata, oracleEvaluation) {
  strictKeys(metadata, ['specDigest', 'planDigest', 'targetArtifactDigest', 'invariantRegistrationId'], 'Trusted result metadata');
  assert(validSha(metadata.specDigest) && validSha(metadata.planDigest) && validSha(metadata.targetArtifactDigest), 'Trusted result metadata digest is invalid');
  assert(typeof metadata.invariantRegistrationId === 'string' && metadata.invariantRegistrationId.length > 0, 'Trusted result invariant is invalid');
  strictKeys(oracleEvaluation, ['execution', 'observedKind', 'observedFields'], 'Oracle evaluation');
  assert(['pass', 'candidate-failure'].includes(oracleEvaluation.execution), 'Oracle evaluation execution is invalid');
  validateObservation(oracleEvaluation.observedKind, oracleEvaluation.observedFields);
  const violationIdentity = oracleEvaluation.execution === 'candidate-failure' ? {
    invariantRegistrationId: metadata.invariantRegistrationId,
    normalizedObservedKind: oracleEvaluation.observedKind,
    normalizedObservedFields: structuredClone(oracleEvaluation.observedFields),
    targetArtifactDigest: metadata.targetArtifactDigest,
  } : null;
  const payload = {
    schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
    specDigest: metadata.specDigest,
    planDigest: metadata.planDigest,
    targetArtifactDigest: metadata.targetArtifactDigest,
    invariantRegistrationId: metadata.invariantRegistrationId,
    evaluatorStatus: 'evaluated',
    execution: oracleEvaluation.execution,
    observedKind: oracleEvaluation.observedKind,
    observedFields: structuredClone(oracleEvaluation.observedFields),
    violationIdentity,
  };
  return { ...payload, payloadDigest: domainDigest(BENCHMARK_RESULT_DIGEST_DOMAIN, payload) };
}
