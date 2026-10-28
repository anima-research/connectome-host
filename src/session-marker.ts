export function sessionMarker(now: Date): string {
  return `--- session ${now.toISOString()} ---`;
}

export const SESSION_MARKER = /^--- session \d{4}-\d{2}-\d{2}T[\d:.]+Z ---$/;
