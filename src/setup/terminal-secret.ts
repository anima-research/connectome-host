import type { Interface } from 'node:readline';
import type { Writable } from 'node:stream';

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

export async function askHidden(
  rl: Interface, output: Writable, label: string, pastingNow: () => boolean = () => false,
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
  if (input !== undefined && pastingNow()) {
    const ended = await new Promise<boolean>((resolve) => {
      const onKey = (_text: unknown, key: { name?: string } | undefined) => {
        if (key?.name === 'paste-end') done(true);
      };
      const onClose = () => done(false);
      const done = (value: boolean) => {
        input.off('keypress', onKey);
        rl.off('close', onClose);
        resolve(value);
      };
      input.on('keypress', onKey);
      rl.once('close', onClose);
    });
    if (!ended) return '';
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
  const others = rl.listeners('line') as Array<(line: string) => void>;
  rl.removeAllListeners('line');
  const lines: string[] = [];
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let whole = () => {};
  let closed = () => {};
  let gone = false;
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
      closed = () => {
        gone = true;
        resolve('');
      };
      rl.once('close', closed);
    });
  } finally {
    clearTimeout(quiet);
    input?.off('keypress', pasted);
    rl.off('close', closed);
    rl.off('line', take);
    for (const listener of others) rl.on('line', listener);
    history.splice(0, history.length, ...before);
    const held = rl as unknown as Record<symbol, unknown>;
    for (const [key, value] of killRing) {
      if (Array.isArray(value) && Array.isArray(held[key])) (held[key] as unknown[]).splice(0, Infinity, ...value);
      else held[key] = value;
    }
    echoing._writeToOutput = write;
    output.write('\n');
    const given = answer.trim();
    if (draft !== '' && !gone && !(given !== '' && draft.includes(given))) rl.write(draft);
  }
}
