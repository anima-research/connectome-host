import { test, expect } from 'bun:test';
import { captureBootConsole, takeBootConsole, MAX_BOOT_CONSOLE_LINES } from '../src/headless-boot-console.js';

test('the boot capture keeps console.error and console.warn lines formatted, prints each once, caps the buffer and puts the methods back', () => {
  const printed: string[] = [];
  const error = console.error, warn = console.warn;
  console.error = (...args: unknown[]) => { printed.push(`E ${args.join(' ')}`); };
  console.warn = (...args: unknown[]) => { printed.push(`W ${args.join(' ')}`); };
  try {
    captureBootConsole();
    captureBootConsole(); // a second install changes nothing
    console.error('Failed to connect MCPL server "%s": %s', 'x', 'refused');
    console.warn('[update]', 'audit', 3);
    for (let i = 0; i < MAX_BOOT_CONSOLE_LINES; i++) console.error('[mcpl] line', i);
    const boot = takeBootConsole();
    expect(boot.lines[0]).toBe('Failed to connect MCPL server "x": refused');
    expect(boot.lines[1]).toBe('[update] audit 3');
    expect(boot.lines).toHaveLength(MAX_BOOT_CONSOLE_LINES);
    expect(boot.dropped).toBe(2);
    expect(printed).toHaveLength(MAX_BOOT_CONSOLE_LINES + 2);
    expect(printed[0]).toBe('E Failed to connect MCPL server "%s": %s x refused');
    // Back to what they were when the capture went in.
    console.error('after');
    expect(printed.at(-1)).toBe('E after');
    expect(takeBootConsole()).toEqual({ lines: [], dropped: 0 });
  } finally {
    console.error = error;
    console.warn = warn;
  }
});
