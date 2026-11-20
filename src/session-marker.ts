export function sessionMarker(now: Date): string {
  return `--- session ${now.toISOString()} ---`;
}

export const SESSION_MARKER = /^--- session \d{4}-\d{2}-\d{2}T[\d:.]+Z ---$/;

/** The line a headless.log that was rolled over live opens with, after its
 *  marker: /bug reads headless.log.1 back to its marker when it sees it. */
export function rolloverNotice(bytes: number): string {
  return `headless.log rolled over at ${bytes} bytes; the lines before this are in headless.log.1`;
}
export const ROLLOVER_NOTICE = /headless\.log rolled over at \d+ bytes; the lines before this are in headless\.log\.1$/;

/** A session that opens with one of these began after a reopen: the path was
 *  gone (deleted, or moved by something other than the host), or the start
 *  ran on stderr until the file could be opened. The run's earlier lines are
 *  not in headless.log.1 (no rollover happened), so `/bug` reads this file
 *  alone and says the run is cut (R5-4). */
export const REOPEN_NOTICE = /headless\.log (?:was gone \(deleted, or moved by something other than the host\) and was opened anew|is open from here; the \d+ bytes of lines before this went to stderr)$/;

/** Whether a session's text opens with a reopen notice (its first lines after the marker). */
export function reopenedLive(session: string): boolean {
  return session.split('\n').slice(0, 4).some((line) => REOPEN_NOTICE.test(line));
}
