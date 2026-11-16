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
