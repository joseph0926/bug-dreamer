const EVENT_PREFIX = 'BUG_DREAMER_EVENT ';

export function emit(phase, data = {}) {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ phase, ...data })}\n`);
}
