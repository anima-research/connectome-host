import { describe, expect, test } from 'bun:test';
import { stopForSessionSwitch } from '../src/session-switch-stop.js';

describe('a session switch stops the current framework', () => {
  test('a stop that resolves logs nothing', async () => {
    const lines: string[] = [];
    let stopped = 0;
    await stopForSessionSwitch({ stop: async () => { stopped++; } }, 'next', (l) => lines.push(l));
    expect(stopped).toBe(1);
    expect(lines).toEqual([]);
  });

  test('a stop that rejects after its teardown lets the switch go on, and says why once', async () => {
    const lines: string[] = [];
    const error = new Error("MCP server 'discord': child 4242 couldn't be confirmed exited");
    await expect(
      stopForSessionSwitch({ stop: async () => { throw error; } }, 'next', (l) => lines.push(l)),
    ).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('switching to session next');
    expect(lines[0]).toContain(error.message);
    expect(lines[0]).toContain('The switch goes on');
  });

  test('a rejection that is not an Error is logged by its text', async () => {
    const lines: string[] = [];
    await stopForSessionSwitch({ stop: () => Promise.reject('child 7 still running') }, 's2', (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('child 7 still running');
  });
});
