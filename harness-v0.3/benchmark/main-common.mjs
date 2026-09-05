import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { parseJsonBytes, canonicalJson } from '../../src/v03-wire.mjs';
import { createVirtualClock } from '../trust/virtual-clock.mjs';
import { loadPrepaintFixtureTools } from './prepaint-environment.mjs';

const FIXTURE_TOOLS_PACKAGE_PATH = '/fixture-tools/package.json';
const CONSUMER_PACKAGE_PATH = '/consumer/package.json';

function fail(message) { throw new TypeError(message); }

async function loadTxPublicModule(specifier) {
  if (specifier !== '@firsttx/tx') fail(`Unregistered tx import specifier: ${specifier}`);
  return import('@firsttx/tx');
}

async function loadPrepaintPublicModule(specifier) {
  if (specifier === '@firsttx/prepaint') return import('@firsttx/prepaint');
  if (specifier === '@firsttx/prepaint/plugin/vite') return import('@firsttx/prepaint/plugin/vite');
  fail(`Unregistered prepaint import specifier: ${specifier}`);
}

async function loadLocalFirstPublicModule(specifier) {
  if (specifier !== '@firsttx/local-first') fail(`Unregistered local-first import specifier: ${specifier}`);
  return import('@firsttx/local-first');
}

export function strictObject(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(`${label} fields changed`);
  return value;
}

export async function readMainInput(inputPath, expectedSchemaVersion, keys) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) fail('Evaluator input path is missing');
  const input = parseJsonBytes(await readFile(inputPath));
  strictObject(input, ['schemaVersion', ...keys], 'Benchmark evaluator input');
  if (input.schemaVersion !== expectedSchemaVersion) fail('Unexpected benchmark evaluator input schemaVersion');
  return input;
}

export async function writeTrustedResult(outputPath, result) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) fail('Evaluator result path is missing');
  await writeFile(outputPath, `${canonicalJson(result)}\n`, { flag: 'wx', mode: 0o600 });
}

function completionGates() {
  const waiting = new Map();
  const released = new Set();
  return {
    waitForGate(gateId, instanceId) {
      const key = `${gateId}\0${instanceId}`;
      if (released.has(key)) return Promise.resolve();
      return new Promise((resolve) => waiting.set(key, resolve));
    },
    release(gateId, instanceId) {
      const key = `${gateId}\0${instanceId}`;
      released.add(key);
      waiting.get(key)?.();
      waiting.delete(key);
    },
  };
}

export function createEvaluatorRuntime(moduleId, artifact, virtualTime) {
  strictObject(artifact, ['role', 'targetArtifactDigest', 'evaluationContractKey'], 'Evaluator artifact');
  strictObject(virtualTime, ['originMs'], 'Evaluator virtual time');
  const teardown = [];
  if (moduleId === 'tx') {
    const clock = createVirtualClock(virtualTime.originMs);
    clock.install();
    teardown.push(() => clock.uninstall());
    const gates = completionGates();
    return {
      runtime: {
        artifact,
        clock,
        loadPublicModule: loadTxPublicModule,
        waitForGate: gates.waitForGate,
        releaseGate: gates.release,
      },
      teardown: () => teardown.reverse().forEach((operation) => operation()),
    };
  }
  if (moduleId === 'prepaint') {
    return {
      runtime: { artifact, fixtureTools: loadPrepaintFixtureTools(), loadPublicModule: loadPrepaintPublicModule },
      teardown: () => {},
    };
  }
  if (moduleId === 'local-first') {
    const fixtureRequire = createRequire(FIXTURE_TOOLS_PACKAGE_PATH);
    const consumerRequire = createRequire(CONSUMER_PACKAGE_PATH);
    return {
      runtime: {
        artifact,
        fixtureTools: { fakeIndexedDB: fixtureRequire('fake-indexeddb') },
        zod: consumerRequire('zod'),
        clock: { nowMs: virtualTime.originMs },
        loadPublicModule: loadLocalFirstPublicModule,
        settle: (promise) => promise,
      },
      teardown: () => {},
    };
  }
  fail(`Unregistered benchmark module: ${moduleId}`);
}

export async function applyMainScheduleControls(controls, instanceId, runtime) {
  for (const control of controls) {
    if (control.kind === 'virtual-time-advance' && control.afterInstanceId === instanceId) await runtime.clock.advance(control.advanceMs);
  }
}

export function releaseCompletionGroup(control, actions, runtime) {
  for (const instanceId of control.instanceIds) {
    const action = actions.find((item) => item.instanceId === instanceId);
    if (action === undefined || action.arguments.gate === null) fail(`Completion release action is invalid: ${instanceId}`);
    runtime.releaseGate(action.arguments.gate, instanceId);
  }
}
