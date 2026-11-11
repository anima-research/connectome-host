export interface UnitRead {
  argv: string[];
  workingDirectory: string;
}

export function readUnit(manager: 'systemd-user' | 'launchd', text: string): UnitRead | { why: string } {
  return { why: `not read: ${manager} ${text.length}` };
}
