import { format } from 'node:util';

/** What the TUI's log takes: the stream behind tui-error.log, or a test's sink. */
export interface ConsoleLogSink {
  write(line: string): unknown;
}

/**
 * Sends `console.error` and `console.warn` to the TUI's log, as readline
 * mode sends them to its own (readline-terminal.ts). Two things keep them
 * out otherwise: Bun's console writes to descriptor 2 itself, past the
 * `process.stderr.write` the TUI redirects; and OpenTUI's renderer, in its
 * default console-overlay mode, replaces the console methods with an append
 * to an in-memory cache shown only under SHOW_CONSOLE. So this runs after
 * the renderer is up, writes each line to the log, and still hands it to
 * the method it found, so the overlay keeps its copy for whoever opens it.
 * The function returned puts back `restoreTo`: the methods from before the
 * renderer, so the TUI's last lines after `destroy()` reach the terminal.
 */
export function routeConsoleToLog(log: ConsoleLogSink, restoreTo: ConsoleMethods = consoleMethods()): () => void {
  const found = consoleMethods();
  for (const level of ['error', 'warn'] as const) {
    const previous = found[level];
    console[level] = (...args: unknown[]) => {
      log.write(`${format(...args)}\n`);
      try { previous(...args); } catch { /* the overlay's own failure is not the log's */ }
    };
  }
  return () => {
    console.error = restoreTo.error;
    console.warn = restoreTo.warn;
  };
}

export interface ConsoleMethods {
  error: typeof console.error;
  warn: typeof console.warn;
}

/** The console methods as they are now: taken before the renderer, they are
 *  Bun's own, which the TUI's end puts back; OpenTUI's `destroy()` restores
 *  the console object, not the methods it reassigned on it. */
export function consoleMethods(): ConsoleMethods {
  return { error: console.error, warn: console.warn };
}
