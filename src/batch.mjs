export function signatureKey(failureSignature) {
  return JSON.stringify({
    oracle_basis_ref: failureSignature?.oracle_basis_ref,
    expected: failureSignature?.expected,
    actual: failureSignature?.actual,
  });
}

export function aggregateRuns(evidences) {
  if (!Array.isArray(evidences) || evidences.length === 0) {
    throw new Error('At least one run is required to aggregate');
  }

  const outcomes = evidences.map((evidence) => evidence.classification.outcome);

  if (outcomes.every((outcome) => outcome === 'pass')) {
    return { outcome: 'pass', signaturesMatch: undefined, reportable: false, rule: 'all-pass' };
  }

  if (outcomes.every((outcome) => outcome === 'candidate-failure')) {
    const keys = new Set(
      evidences.map((evidence) => signatureKey(evidence.classification.failure_signature)),
    );
    const signaturesMatch = keys.size === 1;
    return {
      outcome: 'candidate-failure',
      signaturesMatch,
      reportable: signaturesMatch && evidences.length >= 3,
      rule: signaturesMatch ? 'consistent-candidate-failure' : 'diverging-candidate-failure',
    };
  }

  if (outcomes.every((outcome) => outcome === 'unrunnable')) {
    return {
      outcome: 'unrunnable',
      signaturesMatch: undefined,
      reportable: false,
      rule: 'all-unrunnable',
    };
  }

  return {
    outcome: 'intermittent',
    signaturesMatch: undefined,
    reportable: false,
    rule: 'mixed-outcomes',
  };
}
