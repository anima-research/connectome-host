/**
 * Console notices for batch mode: stdin is not a TTY and `--headless` is
 * absent, so the host reads stdin to EOF, runs each line, then stops the
 * framework. Stopping closes every MCPL server, which `reconnect: true`
 * rightly does not undo (an explicit close is not a transport failure).
 *
 * Without these lines the only trace of that teardown was the per-server
 * mcpl-stderr log's `connection closed (code=null, signal=null)`, which reads
 * like a crash. A host started under a supervisor or `nohup` without
 * `--headless` gets batch mode too, because its stdin is not a TTY, so the
 * notices name the flag that keeps it serving.
 */

const KEEP_SERVING_HINT = 'use --headless to keep serving';

/** Printed once, before stdin is read. */
export function batchModeStartNotice(): string {
  return (
    '[batch] stdin is not a TTY, so this is batch mode: commands are read until stdin closes, ' +
    `then the agent and its MCPL servers stop — ${KEEP_SERVING_HINT}`
  );
}

/** Printed right before the framework stops at the end of a batch run. */
export function batchTeardownNotice(mcplServerIds: readonly string[]): string {
  const n = mcplServerIds.length;
  if (n === 0) return `[batch] stopping the agent: batch run complete — ${KEEP_SERVING_HINT}`;
  return (
    `[batch] closing ${n} MCPL server${n === 1 ? '' : 's'} (${mcplServerIds.join(', ')}): ` +
    `batch run complete — ${KEEP_SERVING_HINT}`
  );
}

/** Written to each server's mcpl-stderr log before the close, so the
 *  `connection closed` line that follows it has a stated cause. */
export const BATCH_MCPL_LOG_NOTE =
  `[host] closing: batch run complete (stdin closed; ${KEEP_SERVING_HINT})`;

/**
 * Printed after the framework stops when the recipe enables the web UI. The
 * web server deliberately outlives the framework (it survives session
 * switches; see WebUiModule.stop), so the process keeps running for it.
 */
export function batchWebUiNotice(url: string): string {
  return (
    `[batch] webui stays up at ${url} with the agent stopped: the page loads but gets ` +
    'no agent data (/healthz answers 503) — Ctrl-C to exit'
  );
}
