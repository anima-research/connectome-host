/**
 * Batch mode stops the framework once stdin ends, which closes every MCPL
 * server, and `reconnect: true` rightly does not undo that (an explicit close
 * is not a transport failure).
 */

import { parseCommand } from './command-name.js';

const KEEP_SERVING_HINT = 'use --headless to keep serving';

export function batchModeStartNotice(): string {
  return (
    '[batch] stdin is not a TTY, so this is batch mode: commands are read until stdin closes, ' +
    `then the agent and its MCPL servers stop — ${KEEP_SERVING_HINT}`
  );
}

export function batchTeardownNotice(mcplServerIds: readonly string[]): string {
  const n = mcplServerIds.length;
  if (n === 0) return `[batch] stopping the agent: batch run complete — ${KEEP_SERVING_HINT}`;
  return (
    `[batch] closing ${n} MCPL server${n === 1 ? '' : 's'} (${mcplServerIds.join(', ')}): ` +
    `batch run complete — ${KEEP_SERVING_HINT}`
  );
}

export const BATCH_MCPL_LOG_NOTE =
  `[host] closing: batch run complete (stdin closed; ${KEEP_SERVING_HINT})`;

export function batchWebUiNotice(url: string): string {
  return (
    `[batch] webui stays up at ${url} with the agent stopped: the page loads but gets ` +
    'no agent data (/healthz answers 503) — Ctrl-C to exit'
  );
}

const AUTH_SUBCOMMANDS = new Set(['status', 'refresh', 'login', 'recheck', 'token']);

/**
 * A stdin line as batch mode echoes it before running it (`> line`). An
 * /auth line's words after a subcommand /auth knows, or from the first word
 * it doesn't know, are shown as `<hidden>`: `/auth token <tok>` sets a
 * credential, and one typed after a misspelt subcommand, or in its place,
 * is still a credential though it runs nothing. Batch output goes wherever
 * the host's stdout goes, a supervisor's journal or a CI log included, and
 * a pasted token is never logged or echoed on the Web UI's route either. A
 * command whose name starts with `auth`, in any case, counts as /auth, and
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
