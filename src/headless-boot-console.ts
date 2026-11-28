/**
 * What a headless host says through console.error and console.warn before
 * its headless.log is open.
 *
 * runHeadless opens headless.log and routes those two console levels into it
 * (see headless.ts), but main() reaches runHeadless only after the recipe is
 * loaded, the framework is created (agent-framework connects its MCPL
 * servers there, and says "Failed to connect MCPL server …" and
 * "[mcpl] … tools/list failed" through console.error when one fails) and
 * started (an update trial's audit says its "[update]" lines there). Those
 * are the lines a /bug from a headless host is most often about, and before
 * this they reached the supervisor's stderr alone. main() installs this
 * capture as soon as the data directory exists; runHeadless takes the buffer
 * after its session marker, writes it, and routes the levels live from then.
 *
 * Kept small and dependency-free: index.ts imports it eagerly.
 */
import { format } from 'node:util';

export const MAX_BOOT_CONSOLE_LINES = 1_000;

type Level = 'error' | 'warn';
type Print = (...args: unknown[]) => void;

let capture: { lines: string[]; dropped: number; print: Record<Level, Print> } | null = null;

/** Buffer console.error and console.warn lines, still printing each one. */
export function captureBootConsole(): void {
  if (capture) return;
  const print = { error: console.error, warn: console.warn };
  const state = { lines: [] as string[], dropped: 0, print };
  for (const level of ['error', 'warn'] as const) {
    console[level] = (...args: unknown[]) => {
      if (state.lines.length < MAX_BOOT_CONSOLE_LINES) state.lines.push(format(...args));
      else state.dropped++;
      print[level](...args);
    };
  }
  capture = state;
}

/**
 * Stop capturing, put the console methods back as they were when the capture
 * was installed, and hand over what was said. Without a capture: nothing.
 */
export function takeBootConsole(): { lines: string[]; dropped: number } {
  const state = capture;
  if (!state) return { lines: [], dropped: 0 };
  capture = null;
  console.error = state.print.error;
  console.warn = state.print.warn;
  return { lines: state.lines, dropped: state.dropped };
}
