/**
 * Stdin line reader using readline's 'line' event: Bun's readline.question and
 * readline/promises question hang, spinning the CPU, on their second call when
 * stdin is a pipe.
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
