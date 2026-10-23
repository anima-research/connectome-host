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

import { parseCommand } from './command-name.js';

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

/** The subcommands /auth's handler knows (handleAuth, commands.ts). */
const AUTH_SUBCOMMANDS = new Set(['status', 'refresh', 'login', 'recheck', 'token']);

/**
 * A stdin line as batch mode echoes it before running it (`> line`). An
 * /auth line's words after a subcommand /auth knows, or from the first word
 * it doesn't know, are shown as `<hidden>`: `/auth token <tok>` sets a
 * credential, and one typed after a misspelt subcommand, or in its place, is
 * still a credential though it runs nothing. Batch output goes wherever the
 * host's stdout goes, a supervisor's journal or a CI log included, and a
 * pasted token is never logged or echoed on the Web UI's route either
 * (CredentialActionMessage). The line is split as handleCommand splits it.
 * A command whose name starts with `auth`, in any case, counts as /auth, and
 * its subcommand is matched in any case: a credential typed after `/AUTH`,
 * `/authtoken` or `/auth-token`, which run nothing, is still a credential,
 * and no other command's name starts with `auth`. Every other line is
 * echoed as it came.
 */
export function batchEchoLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return line;
  const { name, rest } = parseCommand(trimmed);
  if (!name.toLowerCase().startsWith('auth') || rest === '') return line;
  const [sub, ...after] = rest.split(/\s+/);
  if (!AUTH_SUBCOMMANDS.has(sub.toLowerCase())) return `/${name} <hidden>`;
  return after.length === 0 ? line : `/${name} ${sub} <hidden>`;
}
