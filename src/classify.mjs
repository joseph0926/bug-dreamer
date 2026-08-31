import { EVENT_PREFIX } from './constants.mjs';

export function event(phase, data = {}) {
  return `${EVENT_PREFIX}${JSON.stringify({ phase, ...data })}`;
}

export function parseEvents(output) {
  if (output.length === 0) return [];

  return output.split(/\r?\n/u).flatMap((line) => {
    const markerIndex = line.indexOf(EVENT_PREFIX);
    if (markerIndex === -1) return [];

    try {
      return [JSON.parse(line.slice(markerIndex + EVENT_PREFIX.length))];
    } catch {
      return [];
    }
  });
}

export function classifyRun(result) {
  const events = parseEvents(`${result.stdout}\n${result.stderr}`);
  const phases = new Set(events.map((item) => item.phase));
  const scenario = events.find((item) => item.phase === 'P2');
  const actual = events.findLast((item) => item.phase === 'P4');
  const oracleFailure = events.findLast((item) => item.phase === 'ORACLE_FAILURE');

  if (result.timedOut) {
    return classification('unrunnable', 'infrastructure', 'harness-timeout', events);
  }

  if (result.exitCode === 137) {
    return classification('unrunnable', 'infrastructure', 'resource-limit', events);
  }

  if (!phases.has('P1')) {
    return classification('unrunnable', 'infrastructure', 'container-start-failure', events);
  }

  if (!phases.has('P2')) {
    return classification('unrunnable', 'test-definition', 'test-load-failure', events);
  }

  if (phases.has('CONTROL_FAILURE')) {
    return classification('unrunnable', 'test-definition', 'oracle-control-failure', events);
  }

  if (result.exitCode === 0 && phases.has('P3') && phases.has('P4')) {
    return {
      ...classification('pass', undefined, 'oracle-satisfied', events),
      scenario,
      actual,
    };
  }

  if (phases.has('P4') && oracleFailure !== undefined) {
    return {
      ...classification('candidate-failure', undefined, 'oracle-violation', events),
      scenario,
      actual,
      failureSignature: {
        scenario_id: scenario?.scenario_id,
        oracle_basis_ref: scenario?.oracle_basis_ref,
        message: oracleFailure.message,
        expected: oracleFailure.expected,
        actual: oracleFailure.actual,
      },
    };
  }

  return {
    ...classification('unrunnable', 'test-definition', 'ambiguous-test-failure', events),
    scenario,
    actual,
  };
}

function classification(outcome, unrunnableKind, rule, events) {
  return {
    outcome,
    unrunnableKind,
    rule,
    events,
  };
}
