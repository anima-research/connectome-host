import { afterEach, expect, test } from 'bun:test';
import { consoleMethods, routeConsoleToLog } from '../src/tui-console-log.js';

const before = consoleMethods();
afterEach(() => { console.error = before.error; console.warn = before.warn; });

test('console.error and console.warn reach the log, formatted as a line, and still reach the method they replaced', () => {
  const log: string[] = [];
  const overlay: unknown[][] = [];
  // Stand-in for OpenTUI's reassignment, which runs inside createCliRenderer.
  console.error = (...args: unknown[]) => { overlay.push(['error', ...args]); };
  console.warn = (...args: unknown[]) => { overlay.push(['warn', ...args]); };

  const restore = routeConsoleToLog({ write: (line) => log.push(line) }, before);
  console.error('[gate] %s refused: %d', 'rule', 7);
  console.warn('[fit] Not checked', { window: undefined });
  expect(log).toEqual(['[gate] rule refused: 7\n', '[fit] Not checked { window: undefined }\n']);
  expect(overlay).toEqual([['error', '[gate] %s refused: %d', 'rule', 7], ['warn', '[fit] Not checked', { window: undefined }]]);

  restore();
  expect(console.error).toBe(before.error);
  expect(console.warn).toBe(before.warn);
});

test('a replaced method that throws does not keep the line out of the log', () => {
  const log: string[] = [];
  console.error = () => { throw new Error('overlay gone'); };
  const restore = routeConsoleToLog({ write: (line) => log.push(line) }, before);
  expect(() => console.error('still logged')).not.toThrow();
  expect(log).toEqual(['still logged\n']);
  restore();
});

test('with no restoreTo, restore puts back what was found', () => {
  const found = () => {};
  console.warn = found;
  const restore = routeConsoleToLog({ write: () => {} });
  expect(console.warn).not.toBe(found);
  restore();
  expect(console.warn).toBe(found);
});

test('a method something else has already put back is left alone by restore', () => {
  // OpenTUI's destroy() restores the console methods it reassigned; the TUI's
  // restore runs after it, and must not cover what it put back with the
  // methods from before the renderer — in a test child the renderer is made
  // before the TUI, so those are the overlay's, and a Fatal error: line printed
  // after the TUI would go to a destroyed renderer's cache (tui-shutdown.test).
  const restoredByDestroy = () => {};
  const overlay = () => {};
  console.error = overlay;
  const restore = routeConsoleToLog({ write: () => {} }, { error: overlay, warn: overlay });
  console.error = restoredByDestroy;
  restore();
  expect(console.error).toBe(restoredByDestroy);
  expect(console.warn).toBe(overlay);
});
