import { EXECUTION_BUDGET } from './v03-trust.mjs';

const RUN_RECORD_KEYS = ['exitCode', 'stdout', 'stderr', 'stdoutBytes', 'stderrBytes', 'timedOut', 'outputTruncated', 'cleanupError', 'resultEntries', 'rawResult', 'classification'];

// Host evidence envelope only. Result payloads still require trusted classification,
// and each consumer separately checks its case inputs and expected outcome.
export function validateRunRecord(recorded, { assert, label, extraKeys = [] }) {
  const strictKeys = (value, keys, name) => {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
    assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${name} fields changed`);
  };
  strictKeys(recorded, [...RUN_RECORD_KEYS, ...extraKeys], `${label} record`);
  assert(recorded.exitCode === null || Number.isInteger(recorded.exitCode), `${label} exit code is invalid`);
  assert(typeof recorded.timedOut === 'boolean' && typeof recorded.outputTruncated === 'boolean', `${label} execution flags are invalid`);
  assert(recorded.cleanupError === null, `${label} container cleanup failed`);
  assert(!(recorded.timedOut && recorded.outputTruncated), `${label} reports both a timeout and a truncation`);
  for (const stream of ['stdout', 'stderr']) {
    const observedBytes = recorded[`${stream}Bytes`];
    assert(typeof recorded[stream] === 'string', `${label} ${stream} record is not a string`);
    assert(Number.isInteger(observedBytes) && observedBytes >= 0, `${label} ${stream} byte count is invalid`);
    const storedBytes = Buffer.byteLength(recorded[stream], 'utf8');
    assert(storedBytes <= EXECUTION_BUDGET.recordedOutputBytes, `${label} ${stream} record exceeds the cap`);
    if (observedBytes <= EXECUTION_BUDGET.recordedOutputBytes) assert(storedBytes === observedBytes, `${label} ${stream} record is incomplete`);
  }
  const overflowed = recorded.stdoutBytes > EXECUTION_BUDGET.stdoutLimitBytes || recorded.stderrBytes > EXECUTION_BUDGET.stderrLimitBytes;
  assert(recorded.outputTruncated === overflowed, `${label} truncation flag disagrees with the recorded byte counts`);
  assert(recorded.rawResult === null || typeof recorded.rawResult === 'string', `${label} raw result is invalid`);
  assert(Array.isArray(recorded.resultEntries), `${label} result entries are invalid`);
  if (recorded.rawResult === null) {
    assert(recorded.resultEntries.length === 0, `${label} recorded result files without a raw result`);
  } else {
    assert(recorded.resultEntries.length === 1, `${label} result file universe changed`);
    const [entry] = recorded.resultEntries;
    strictKeys(entry, ['name', 'type', 'size'], `${label} result entry`);
    assert(entry.name === 'result.json', `${label} result file name changed`);
    assert(entry.type === 'regular', `${label} result entry is not a regular file`);
    assert(Number.isInteger(entry.size) && entry.size >= 0, `${label} result entry size is invalid`);
    assert(entry.size === Buffer.byteLength(recorded.rawResult, 'utf8'), `${label} result size mismatch`);
  }
  assert(recorded.classification !== null && typeof recorded.classification === 'object' && !Array.isArray(recorded.classification), `${label} classification is invalid`);
}
