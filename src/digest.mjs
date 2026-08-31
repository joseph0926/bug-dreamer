export const DIGEST_SCENARIO_BUDGET = 20;

export function assertDigestBudget(scenarioCount) {
  if (!Number.isInteger(scenarioCount) || scenarioCount < 0) {
    throw new Error('Scenario count must be a non-negative integer');
  }
  if (scenarioCount > DIGEST_SCENARIO_BUDGET) {
    throw new Error(
      `Batch of ${scenarioCount} scenarios exceeds the recorded budget of ${DIGEST_SCENARIO_BUDGET}; nothing was executed`,
    );
  }
}

export function renderDigest(batch, date, meta = {}) {
  const candidates = batch.results.filter((result) => result.aggregate.reportable);
  const excluded = { pass: 0, unrunnable: 0, intermittent: 0, 'diverging-candidate-failure': 0 };
  for (const result of batch.results) {
    if (result.aggregate.reportable) continue;
    if (result.aggregate.rule === 'diverging-candidate-failure') {
      excluded['diverging-candidate-failure'] += 1;
    } else {
      excluded[result.aggregate.outcome] = (excluded[result.aggregate.outcome] ?? 0) + 1;
    }
  }

  const lines = [
    `# Candidate digest — ${date}`,
    '',
    `Target module: ${batch.module}`,
    `Scenarios: ${batch.scenario_count} from ${batch.scenario_directory}, ${batch.runs_per_scenario} consecutive runs each`,
    'Run: unattended, isolated',
  ];
  if (batch.execution?.duration_ms !== undefined) {
    lines.push(`Execution time: ${batch.execution.duration_ms} ms`);
  }
  lines.push(`Model calls: ${meta.modelCalls ?? 'not-recorded'}`);
  if (meta.evidenceRef !== undefined) {
    lines.push(`Evidence: ${meta.evidenceRef}`);
  }
  lines.push(
    '',
    'Every entry below is a candidate, not a reported nightmare. Promotion to nightmares/ requires an accepted independent reproduction and a human verdict under the v0.1 rules.',
    '',
    '## Candidates',
    '',
  );

  if (candidates.length === 0) {
    lines.push('None. No scenario produced a consistent candidate failure.');
  } else {
    for (const result of candidates) {
      const signature = result.runs.find(
        (run) => run.classification?.failure_signature !== undefined,
      )?.classification.failure_signature;
      lines.push(`### ${result.scenario}`);
      lines.push('');
      lines.push(`- Outcome: candidate-failure in ${result.runs.length}/${result.runs.length} runs with one signature`);
      if (signature?.oracle_basis_ref !== undefined) {
        lines.push(`- Oracle: ${signature.oracle_basis_ref}`);
      }
      if (signature?.expected !== undefined) {
        lines.push(`- Expected: ${JSON.stringify(signature.expected)}`);
        lines.push(`- Actual: ${JSON.stringify(signature.actual)}`);
      }
      const reproduction = result.runs[0]?.reproduction?.command;
      if (reproduction !== undefined) {
        lines.push(`- Reproduction: \`${reproduction}\``);
      }
      if (meta.evidenceRef !== undefined) {
        lines.push(`- Evidence: ${meta.evidenceRef} (results entry for ${result.scenario})`);
      }
      lines.push('');
    }
  }

  lines.push('## Excluded from this digest');
  lines.push('');
  lines.push(
    `- pass: ${excluded.pass}, unrunnable: ${excluded.unrunnable}, intermittent: ${excluded.intermittent}, diverging signatures: ${excluded['diverging-candidate-failure']}`,
  );
  lines.push('');
  return lines.join('\n');
}
