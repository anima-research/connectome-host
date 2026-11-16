import { appendFileSync } from 'node:fs';
import { SHOWN_FILE } from '../setup/commands-shown.js';
import type { CliContext } from './connectome.js';

export function shownToPerson<T extends Pick<CliContext, 'out' | 'err'>>(
  ctx: T,
  env: Record<string, string | undefined> = process.env,
): T {
  const file = env[SHOWN_FILE];
  if (!file) return ctx;
  let writing = true;
  const also = (line: string) => {
    if (!writing) return;
    try {
      appendFileSync(file, `${line}\n`);
    } catch (error) {
      writing = false;
      ctx.err(`connectome: setup's agent named ${file} for what this command prints to reach the person's screen, and ` +
        `it can't be written (${(error as Error).message}), so the person sees neither the line above nor what it ` +
        'prints after it: tell them what it says.');
    }
  };
  return {
    ...ctx,
    out: (line: string) => { ctx.out(line); also(line); },
    err: (line: string) => { ctx.err(line); also(line); },
  };
}
