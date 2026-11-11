import type { Interface } from 'node:readline';
import type { Writable } from 'node:stream';
import type { BracketedPaste } from '../readline-paste.js';

type Echoing = Interface & { _writeToOutput?: unknown; history?: unknown };

export const PASTE_QUIET_MS = 250;

// Bun 1.4.4's readline keeps text killed with Ctrl-U, Ctrl-K or Ctrl-W in a kill ring that Ctrl-Y yanks back, under
// symbols that aren't part of its documented interface (probed).
const KILL_RING = new Set(['_killRing', '_killRingCursor', '_yanking']);

function killRingOf(rl: Interface): Array<[symbol, unknown]> {
  const held = rl as unknown as Record<symbol, unknown>;
  return Object.getOwnPropertySymbols(rl).filter((key) => KILL_RING.has(key.description ?? ''))
    .map((key) => [key, Array.isArray(held[key]) ? [...held[key] as unknown[]] : held[key]]);
}

/** Whether text holds a line of an answer given hidden, its ASCII letters in any case, as setup matches a stored secret
 *  everywhere it hides or cleans one out. */
export function holdsAnswer(text: string, given: readonly string[]): boolean {
  const folded = text.toLowerCase();
  return given.some((line) => folded.includes(line.toLowerCase()));
}

export async function askHidden(
  rl: Interface, output: Writable, label: string, paste?: Pick<BracketedPaste, 'pasting' | 'drop'>,
): Promise<string> {
  const echoing = rl as Echoing;
  const write = echoing._writeToOutput;
  // readline echoes what's typed through its own _writeToOutput, which isn't part of its documented interface.
  if (typeof write !== 'function') {
    throw new Error('this terminal\'s readline offers no way to keep what\'s typed from showing');
  }
  const killRing = killRingOf(rl);
  if (!killRing.some(([key]) => key.description === '_killRing') || !Array.isArray(echoing.history)) {
    throw new Error('setup can\'t find this terminal\'s readline history or kill ring, so it couldn\'t keep what\'s typed ' +
      'out of them');
  }
  // Bun 1.4.4's readline tells a bracketed paste's start and end apart only as keypresses named paste-start and
  // paste-end (readline-paste.ts).
  const input = (rl as unknown as { input?: NodeJS.EventEmitter }).input;
  let gone = false;
  let closed = () => {};
  const onClose = () => {
    gone = true;
    closed();
  };
  rl.once('close', onClose);
  if (input !== undefined && paste?.pasting()) {
    await new Promise<void>((resolve) => {
      const onKey = (_text: unknown, key: { name?: string } | undefined) => {
        if (key?.name === 'paste-end') done();
      };
      const done = () => {
        input.off('keypress', onKey);
        closed = () => {};
        resolve();
      };
      closed = done;
      input.on('keypress', onKey);
    });
    if (gone) return '';
  }
  const draft = rl.line;
  if (draft !== '') {
    rl.write(null, { ctrl: true, name: 'e' });
    rl.write(null, { ctrl: true, name: 'u' });
  }
  output.write(`\n${label}: `);
  echoing._writeToOutput = () => {};
  const history = echoing.history as string[];
  const before = [...history];
  const others = rl.rawListeners('line') as Array<(line: string) => void>;
  rl.removeAllListeners('line');
  const lines: string[] = [];
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let whole = () => {};
  let pasting = false;
  let answer = '';
  let tookInPaste = false;
  const take = (line: string) => {
    // readline puts a line in its history before it hands the line on.
    history.splice(0);
    if (line !== '') lines.push(line);
    clearTimeout(quiet);
    if (pasting) tookInPaste = true;
    else quiet = setTimeout(() => whole(), PASTE_QUIET_MS);
  };
  const pasted = (_text: unknown, key: { name?: string } | undefined) => {
    if (key?.name === 'paste-start') {
      pasting = true;
      clearTimeout(quiet);
    } else if (key?.name === 'paste-end') {
      pasting = false;
      if (tookInPaste) quiet = setTimeout(() => whole(), PASTE_QUIET_MS);
    }
  };
  try {
    history.splice(0);
    input?.on('keypress', pasted);
    rl.on('line', take);
    return await new Promise<string>((resolve) => {
      whole = () => {
        // A paste whose last line has no line break leaves that line in readline's rl.line, where the next Enter
        // would send it on; written a line break, readline ends it as Enter would, handing it to take.
        if (rl.line !== '') rl.write('\n');
        clearTimeout(quiet);
        answer = lines.join('\n');
        resolve(answer);
      };
      closed = () => resolve('');
    });
  } finally {
    clearTimeout(quiet);
    input?.off('keypress', pasted);
    rl.off('close', onClose);
    rl.off('line', take);
    for (const listener of others) rl.on('line', listener);
    const given = answer.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    history.splice(0, history.length, ...before.filter((entry) => !holdsAnswer(entry, given)));
    const held = rl as unknown as Record<symbol, unknown>;
    const ring = killRing.find(([key]) => key.description === '_killRing')?.[1];
    const kept = Array.isArray(ring) ? ring.filter((entry) => !holdsAnswer(String(entry), given)) : ring;
    // Ctrl-Y yanks the ring's entry at its cursor, which can be past the end once entries are gone, and Meta-Y takes out
    // the last yank by that entry's length. So with entries gone, the cursor goes back to the newest and no yank goes on.
    const moved = Array.isArray(ring) && (kept as unknown[]).length < ring.length;
    for (const [key, value] of killRing) {
      const back = key.description === '_killRing' ? kept
        : !moved ? value
        : key.description === '_killRingCursor' ? 0
        : false;
      if (Array.isArray(back) && Array.isArray(held[key])) (held[key] as unknown[]).splice(0, Infinity, ...back);
      else held[key] = back;
    }
    echoing._writeToOutput = write;
    output.write('\n');
    const dropped = given.length === 0 ? undefined : paste?.drop((line) => holdsAnswer(line, given));
    if (dropped !== undefined && dropped.taken > 0) {
      output.write(`${dropped.taken === 1 ? '1 pasted line' : `${dropped.taken} pasted lines`} held what you just entered ` +
        `hidden, so ${dropped.taken === 1 ? 'it was' : 'they were'} taken out${dropped.left > 0 ? '. Enter sends the rest' : ''}.\n`);
    }
    if (draft !== '' && !gone) {
      if (!holdsAnswer(draft, given)) rl.write(draft);
      else output.write('What you\'d typed held what you just entered hidden, so it was taken out.\n');
    }
  }
}
