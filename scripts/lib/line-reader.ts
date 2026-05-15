/**
 * Stdin line reader using readline's 'line' event. Robust to piped input
 * (Bun 1.3's readline.question / readline/promises.question hang at 99% CPU
 * on subsequent calls when stdin is a pipe). Keep one reader instance alive
 * for the whole script's main() — close/re-open per question is also flaky.
 *
 * Shared between scripts/evacuator.ts and scripts/import-claudeai-export.ts;
 * if the upstream Bun bug ever gets fixed there is exactly one place to
 * revert.
 */
import { createInterface } from 'node:readline';

export interface LineReader {
  nextLine(prompt?: string): Promise<string | null>;
  close(): void;
}

export function createLineReader(): LineReader {
  const buf: string[] = [];
  let resolveNext: ((s: string | null) => void) | null = null;
  let closed = false;
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line: string) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(line);
    } else {
      buf.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(null);
    }
  });
  return {
    nextLine(prompt?: string) {
      if (prompt) process.stdout.write(prompt);
      return new Promise<string | null>((resolve) => {
        if (buf.length > 0) resolve(buf.shift()!);
        else if (closed) resolve(null);
        else resolveNext = resolve;
      });
    },
    close() {
      rl.close();
    },
  };
}
