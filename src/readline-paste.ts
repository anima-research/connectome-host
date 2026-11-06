import type { Interface } from 'node:readline';

export const PASTE_ON = '\x1b[?2004h';
export const PASTE_OFF = '\x1b[?2004l';

type Signals = Pick<NodeJS.Process, 'on' | 'off' | 'kill' | 'listenerCount' | 'pid'>;

const ENDING_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

export interface BracketedPaste {
  take(line: string): string | null;
  pasting(): boolean;
  drop(secrets: readonly string[]): { taken: number; left: number };
  end(): number;
}

/**
 * Readline hands each line of a paste to its 'line' listeners as if it were typed, and Bun's readline (1.4.4, probed)
 * tells a bracketed paste's start and end apart only as keypresses named paste-start and paste-end. A terminal that
 * doesn't support the mode sends no paste-start.
 */
export function bracketedPaste(rl: Interface, input: NodeJS.ReadStream, output: NodeJS.WriteStream,
  held: (lines: number) => void, signals: Signals = process): BracketedPaste {
  let pasting = false;
  let on = true;
  const lines: string[] = [];
  const off = (): void => {
    if (!on) return;
    on = false;
    try {
      output.write(PASTE_OFF);
    } catch {
    }
  };
  const onKey = (_text: string | undefined, key: { name?: string } | undefined): void => {
    if (key?.name === 'paste-start') pasting = true;
    else if (key?.name === 'paste-end') {
      pasting = false;
      if (lines.length > 0) held(lines.length + (rl.line === '' ? 0 : 1));
    }
  };
  const onSignal = (signal: (typeof ENDING_SIGNALS)[number]): void => {
    off();
    for (const each of ENDING_SIGNALS) signals.off(each, onEach[each]);
    if (signals.listenerCount(signal) === 0) signals.kill(signals.pid, signal);
  };
  const onEach = {
    SIGTERM: () => onSignal('SIGTERM'), SIGINT: () => onSignal('SIGINT'), SIGHUP: () => onSignal('SIGHUP'),
  };
  input.on('keypress', onKey);
  signals.on('exit', off);
  for (const each of ENDING_SIGNALS) signals.on(each, onEach[each]);
  output.write(PASTE_ON);
  return {
    pasting: () => pasting,
    drop(secrets) {
      const before = lines.length;
      for (let at = lines.length - 1; at >= 0; at--) if (secrets.some((secret) => lines[at]!.includes(secret))) lines.splice(at, 1);
      return { taken: before - lines.length, left: lines.length };
    },
    take(line) {
      if (pasting) {
        lines.push(line);
        return null;
      }
      return lines.length === 0 ? line : [...lines.splice(0), line].join('\n');
    },
    end() {
      off();
      input.off('keypress', onKey);
      signals.off('exit', off);
      for (const each of ENDING_SIGNALS) signals.off(each, onEach[each]);
      return lines.splice(0).length;
    },
  };
}
