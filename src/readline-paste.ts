import type { Interface } from 'node:readline';

export const PASTE_ON = '\x1b[?2004h';
export const PASTE_OFF = '\x1b[?2004l';

type Signals = Pick<NodeJS.Process, 'on' | 'off' | 'kill' | 'listenerCount' | 'pid'>;

export interface BracketedPaste {
  take(line: string): string | null;
  end(): void;
}

/**
 * Bracketed paste for readline mode. Readline hands each line of a paste to its 'line' listeners as if it were typed,
 * and Bun's readline (1.4.4, probed) tells a bracketed paste's start and end apart only as keypresses named
 * paste-start and paste-end. So the terminal's bracketed paste is turned on here, the lines that end inside a paste
 * are held, and the person's next Enter sends them with the line it ends; `held` is told how many lines wait after a
 * paste that left any. A terminal that doesn't support the mode sends no paste-start, and its lines go on as typed.
 * The mode goes off again however the host leaves: end(), the process exiting, or a SIGTERM, which this restores
 * before the signal's own death when nothing else in the process handles it.
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
  const onTerm = (): void => {
    off();
    signals.off('SIGTERM', onTerm);
    if (signals.listenerCount('SIGTERM') === 0) signals.kill(signals.pid, 'SIGTERM');
  };
  input.on('keypress', onKey);
  signals.on('exit', off);
  signals.on('SIGTERM', onTerm);
  output.write(PASTE_ON);
  return {
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
      signals.off('SIGTERM', onTerm);
    },
  };
}
