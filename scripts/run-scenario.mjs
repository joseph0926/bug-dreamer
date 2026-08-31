import { randomUUID } from 'node:crypto';

import { classifyRun } from '../src/classify.mjs';
import {
  DEFAULT_TIMEOUT_MS,
  IMAGE_TAG,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  RUN_LIMITS,
  TARGET_MODULE,
  TARGET_PROJECT,
  TARGET_REVISION,
} from '../src/constants.mjs';
import { buildDockerRunArgs } from '../src/docker-command.mjs';
import { runCommand } from '../src/process.mjs';
import { inspectScenario, relativeScenarioPath } from '../src/scenario-file.mjs';

function parseArgs(args) {
  let scenario;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name}`);
    if (name === '--scenario') scenario = value;
    else if (name === '--timeout-ms') timeoutMs = Number(value);
    else throw new Error(`Unknown option: ${name}`);
  }

  if (scenario === undefined) {
    throw new Error(
      'Usage: node scripts/run-scenario.mjs --scenario <scenario.test.ts> [--timeout-ms <milliseconds>]',
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Timeout must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }

  return { scenario, timeoutMs };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function highestPhase(events) {
  const phases = ['P1', 'P2', 'P3', 'P4'];
  return phases.findLast((phase) => events.some((item) => item.phase === phase));
}

async function removeContainer(containerName) {
  await runCommand('docker', ['rm', '--force', containerName]);
}

async function main() {
  const { scenario: scenarioInput, timeoutMs } = parseArgs(process.argv.slice(2));
  const scenario = await inspectScenario(scenarioInput);
  const image = await runCommand('docker', [
    'image',
    'inspect',
    '--format',
    '{{.Id}} {{index .Config.Labels "org.bug-dreamer.dependencies-ref"}}',
    IMAGE_TAG,
  ]);
  if (image.exitCode !== 0) {
    throw new Error(`Runner image is unavailable. Run the prepare command first.\n${image.stderr.trim()}`);
  }

  const [imageId, dependenciesRef] = image.stdout.trim().split(' ');
  const containerName = `bug-dreamer-${process.pid}-${randomUUID()}`;
  const dockerArgs = buildDockerRunArgs({
    scenarioPath: scenario.path,
    containerName,
  });
  const result = await runCommand('docker', dockerArgs, {
    timeoutMs,
    onTimeout: () => removeContainer(containerName),
  });
  const classified = classifyRun(result);
  const commandScenario = relativeScenarioPath(process.cwd(), scenario.path);
  const scenarioMetadata = classified.scenario ?? {};
  const actual = classified.actual?.actual;
  const evidence = {
    scenario_id: scenarioMetadata.scenario_id ?? scenario.name,
    target: {
      project: TARGET_PROJECT,
      project_revision: TARGET_REVISION,
      module: TARGET_MODULE,
    },
    environment: {
      isolation: 'docker',
      image_or_os: `${IMAGE_TAG}@${imageId}`,
      runtime: 'node 24.16.0',
      dependencies_ref: dependenciesRef,
      limits: {
        network: 'blocked',
        allowed_commands: ['vitest run .bug-dreamer/generated.test.ts'],
        timeout_ms: timeoutMs,
        memory: RUN_LIMITS.memory,
        cpus: RUN_LIMITS.cpus,
        pids: RUN_LIMITS.pids,
        temporary_filesystems: {
          general: RUN_LIMITS.tmpfs,
          vite_config: RUN_LIMITS.viteTmpfs,
        },
      },
    },
    test: {
      test_ref: scenario.name,
      test_hash: scenario.hash,
      oracle_basis: scenarioMetadata.oracle_basis,
      oracle_basis_ref: scenarioMetadata.oracle_basis_ref,
      control_ref: scenarioMetadata.control_ref,
    },
    reproduction: {
      command: `asdf exec node scripts/run-scenario.mjs --scenario ${shellQuote(commandScenario)} --timeout-ms ${timeoutMs}`,
      working_directory: '.',
    },
    inputs: scenarioMetadata.inputs,
    expected: scenarioMetadata.expected,
    actual,
    runs: {
      attempts: 1,
      failures: classified.outcome === 'candidate-failure' ? 1 : 0,
      per_run: [
        {
          phase_reached: highestPhase(classified.events),
          outcome: classified.outcome,
          duration_ms: result.durationMs,
          exit_reason: result.timedOut
            ? 'timeout'
            : result.signal === null
              ? `exit-${result.exitCode}`
              : `signal-${result.signal}`,
        },
      ],
    },
    classification: {
      outcome: classified.outcome,
      unrunnable_kind: classified.unrunnableKind,
      failure_signature: classified.failureSignature,
      rule: classified.rule,
    },
    logs: {
      excerpt: `${result.stdout}${result.stderr}`.slice(0, 8192),
      full_ref: null,
    },
    human_verdict: 'unreviewed',
  };

  process.stdout.write(`${JSON.stringify({ evidence }, null, 2)}\n`);
  process.exitCode = classified.outcome === 'pass' ? 0 : classified.outcome === 'candidate-failure' ? 1 : 2;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
