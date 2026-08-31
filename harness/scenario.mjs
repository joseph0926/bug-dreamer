import { expect, test } from 'vitest';

import { emit } from './events.mjs';

const oracleBases = new Set([
  'documentation',
  'existing-test',
  'public-type',
  'declared-invariant',
]);

function serialize(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function validateDefinition(definition) {
  if (typeof definition?.id !== 'string' || definition.id.length === 0) {
    throw new TypeError('Scenario id is required');
  }
  if (!oracleBases.has(definition.oracle?.basis)) {
    throw new TypeError('Scenario oracle basis is invalid');
  }
  if (typeof definition.oracle?.ref !== 'string' || definition.oracle.ref.length === 0) {
    throw new TypeError('Scenario oracle reference is required');
  }
  if (typeof definition.expected !== 'string' || definition.expected.length === 0) {
    throw new TypeError('Scenario expected result is required');
  }
  if (typeof definition.act !== 'function' || typeof definition.assert !== 'function') {
    throw new TypeError('Scenario act and assert functions are required');
  }
  if (definition.control !== undefined && typeof definition.control !== 'function') {
    throw new TypeError('Scenario control must be a function');
  }
}

export function defineScenario(definition) {
  validateDefinition(definition);
  emit('P2', {
    scenario_id: definition.id,
    oracle_basis: definition.oracle.basis,
    oracle_basis_ref: definition.oracle.ref,
    control_ref: definition.controlRef,
    inputs: serialize(definition.inputs),
    expected: definition.expected,
  });

  test(definition.id, async () => {
    if (definition.control !== undefined) {
      try {
        await definition.control(expect);
      } catch (error) {
        emit('CONTROL_FAILURE', { message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }

    emit('P3');
    const actual = await definition.act();
    emit('P4', { actual: serialize(actual) });

    try {
      await definition.assert(actual, expect);
    } catch (error) {
      if (error instanceof Error && error.name === 'AssertionError') {
        emit('ORACLE_FAILURE', {
          message: error.message,
          expected: serialize(error.expected),
          actual: serialize(error.actual),
        });
      }
      throw error;
    }
  });
}
