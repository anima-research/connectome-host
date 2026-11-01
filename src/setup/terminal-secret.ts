import type { Interface } from 'node:readline';
import type { Writable } from 'node:stream';

type Echoing = Interface & { _writeToOutput?: unknown; history?: unknown };

/** How long input must stay quiet after a hidden answer before it counts as whole. */
export const PASTE_QUIET_MS = 250;

// Bun 1.4.4's readline keeps text killed with Ctrl-U, Ctrl-K or Ctrl-W in a kill ring that Ctrl-Y yanks back, under
// symbols that aren't part of its documented interface (probed).
const KILL_RING = new Set(['_killRing', '_killRingCursor', '_yanking']);

function killRingOf(rl: Interface): Array<[symbol, unknown]> {
  const held = rl as unknown as Record<symbol, unknown>;
  return Object.getOwnPropertySymbols(rl).filter((key) => KILL_RING.has(key.description ?? ''))
    .map((key) => [key, Array.isArray(held[key]) ? [...held[key] as unknown[]] : held[key]]);
}

/** Asks for one line after `label` and a colon, on a line of its own, with nothing echoed: the line typed, or '' if
 *  the interface closes before the answer is whole. The label says what Enter alone does where it's asked.
 *  Text typed but not sent when it asks is taken away first, so it can't start the answer. The lines that come
 *  within PASTE_QUIET_MS of each other after it, as the rest of a pasted text, join it with line breaks, a last line
 *  with no line break of its own included, and lines with nothing on them are left out. None of them reaches the
 *  'line' listeners the interface had when asked. Its history holds nothing while it asks, so Up recalls nothing,
 *  and is left as it was before the question, and so is its kill ring, so text killed while it asks can't be yanked
 *  after. Throws, asking nothing, where readline offers no way to hide what's typed. */
export async function askHidden(rl: Interface, output: Writable, label: string): Promise<string> {
  const echoing = rl as Echoing;
  const write = echoing._writeToOutput;
  // readline echoes what's typed through its own _writeToOutput, which isn't part of its documented interface.
  if (typeof write !== 'function') {
    throw new Error('this terminal\'s readline offers no way to keep what\'s typed from showing');
  }
  const killRing = killRingOf(rl);
  if (rl.line !== '') {
    rl.write(null, { ctrl: true, name: 'e' });
    rl.write(null, { ctrl: true, name: 'u' });
  }
  output.write(`\n${label}: `);
  echoing._writeToOutput = () => {};
  const history = Array.isArray(echoing.history) ? echoing.history as string[] : null;
  const before = history ? [...history] : [];
  const others = rl.listeners('line') as Array<(line: string) => void>;
  rl.removeAllListeners('line');
  const lines: string[] = [];
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let whole = () => {};
  let closed = () => {};
  const take = (line: string) => {
    // readline puts a line in its history before it hands the line on.
    history?.splice(0);
    if (line !== '') lines.push(line);
    clearTimeout(quiet);
    quiet = setTimeout(() => whole(), PASTE_QUIET_MS);
  };
  try {
    history?.splice(0);
    rl.on('line', take);
    return await new Promise<string>((resolve) => {
      whole = () => {
        // A paste whose last line has no line break leaves that line in readline's rl.line, where the next Enter
        // would send it on; written a line break, readline ends it as Enter would, handing it to take.
        if (rl.line !== '') rl.write('\n');
        clearTimeout(quiet);
        resolve(lines.join('\n'));
      };
      closed = () => resolve('');
      rl.once('close', closed);
    });
  } finally {
    clearTimeout(quiet);
    rl.off('close', closed);
    rl.off('line', take);
    for (const listener of others) rl.on('line', listener);
    if (history) history.splice(0, history.length, ...before);
    const held = rl as unknown as Record<symbol, unknown>;
    for (const [key, value] of killRing) {
      if (Array.isArray(value) && Array.isArray(held[key])) (held[key] as unknown[]).splice(0, Infinity, ...value);
      else held[key] = value;
    }
    echoing._writeToOutput = write;
    output.write('\n');
  }
}
