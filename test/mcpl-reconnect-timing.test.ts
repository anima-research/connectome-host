import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkReconnectTiming,
  mergeRecipeServers,
  overlayWarnings,
  RECONNECT_MAX_INTERVAL_CEILING_MS,
  resolveOverlayEntry,
  startServers,
} from '../src/mcpl-config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function overlayFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'reconnect-timing-'));
  dirs.push(dir);
  const path = join(dir, 'mcpl-servers.agent.json');
  writeFileSync(path, text);
  return path;
}

const INTERVAL_DEFAULT = "so it's left out and the default, 5 seconds, applies";
const MAX_DEFAULT = "so it's left out and the default, 5 minutes, applies";

describe('checkReconnectTiming', () => {
  test.each([
    ['0', 0, 'is 0, which isn\'t above 0'],
    ['a negative', -5, 'is -5, which isn\'t above 0'],
    ['Infinity, as JSON gives 1e999', Infinity, 'is Infinity, which isn\'t finite'],
    ['text that is no number', '5s', 'is text that doesn\'t read as a finite number'],
    ['empty text, which JavaScript\'s arithmetic reads as 0', '', 'is text that reads as 0, which isn\'t above 0'],
    ['quoted 0', '0', 'is text that reads as 0, which isn\'t above 0'],
    ['quoted digits past a double\'s range, which read as Infinity', '9'.repeat(400), 'is text that doesn\'t read as a finite number'],
    ['true, which JavaScript\'s arithmetic reads as 1', true, 'is true, which isn\'t a number'],
    ['an object', { ms: 5000 }, 'isn\'t a number'],
  ])('an interval of %s is dropped, so the framework waits its default', (_what, value, problem) => {
    const server: Record<string, unknown> = { id: 's', command: 'node', reconnect: true, reconnectIntervalMs: value };
    expect(checkReconnectTiming(server)).toEqual([`its reconnectIntervalMs ${problem}, ${INTERVAL_DEFAULT}`]);
    expect('reconnectIntervalMs' in server).toBe(false);
  });

  test.each([
    ['0', 0, 'is 0, which isn\'t above 0'],
    ['a negative', -1, 'is -1, which isn\'t above 0'],
    ['Infinity, as JSON gives 1e999', Infinity, 'is Infinity, which isn\'t finite'],
    ['one above the ceiling', RECONNECT_MAX_INTERVAL_CEILING_MS + 1, `is ${RECONNECT_MAX_INTERVAL_CEILING_MS + 1}, above the most it can be, ${RECONNECT_MAX_INTERVAL_CEILING_MS}`],
    ['quoted one above the ceiling', String(RECONNECT_MAX_INTERVAL_CEILING_MS + 1), `is text that reads as ${RECONNECT_MAX_INTERVAL_CEILING_MS + 1}, above the most it can be, ${RECONNECT_MAX_INTERVAL_CEILING_MS}`],
  ])('a max of %s is dropped, so the framework caps at its default', (_what, value, problem) => {
    const server: Record<string, unknown> = { id: 's', command: 'node', reconnect: true, reconnectMaxIntervalMs: value };
    expect(checkReconnectTiming(server)).toEqual([`its reconnectMaxIntervalMs ${problem}, ${MAX_DEFAULT}`]);
    expect('reconnectMaxIntervalMs' in server).toBe(false);
  });

  test('a note never echoes text or an object written there, only a number', () => {
    const server: Record<string, unknown> = { id: 's', command: 'node', reconnect: true, reconnectIntervalMs: 'sk-secret-token', reconnectMaxIntervalMs: { token: 'sk-secret-token' } };
    const notes = checkReconnectTiming(server);
    expect(notes).toHaveLength(2);
    for (const note of notes) expect(note).not.toContain('secret');
  });

  test('the max ceiling guards the legacy engine, which waits up to 1.25 times the capped wait without clamping it, until agent-framework\'s fix reaches the host: at the ceiling the longest wait fits a timer, which fires at once past 2,147,483,647 ms', () => {
    expect(RECONNECT_MAX_INTERVAL_CEILING_MS).toBe(1_717_986_917);
    expect(RECONNECT_MAX_INTERVAL_CEILING_MS * 1.25).toBeLessThanOrEqual(2_147_483_647);
    expect((RECONNECT_MAX_INTERVAL_CEILING_MS + 1) * 1.25).toBeGreaterThan(2_147_483_647);
    const server: Record<string, unknown> = { id: 's', command: 'node', reconnect: true, reconnectMaxIntervalMs: RECONNECT_MAX_INTERVAL_CEILING_MS };
    expect(checkReconnectTiming(server)).toEqual([]);
    expect(server.reconnectMaxIntervalMs).toBe(RECONNECT_MAX_INTERVAL_CEILING_MS);
  });

  test('quoted text that JavaScript\'s arithmetic reads as a finite number above 0 is read as that number, as agent-framework would, with a note to write it without quotes', () => {
    const server: Record<string, unknown> = { id: 's', command: 'node', reconnect: true, reconnectIntervalMs: '.5', reconnectMaxIntervalMs: '6e5' };
    expect(checkReconnectTiming(server)).toEqual([
      'its reconnectIntervalMs is quoted, read as the number 0.5: write it as the number 0.5, without quotes',
      'its reconnectMaxIntervalMs is quoted, read as the number 600000: write it as the number 600000, without quotes',
    ]);
    expect(server.reconnectIntervalMs).toBe(0.5);
    expect(server.reconnectMaxIntervalMs).toBe(600000);
  });

  test('null passes as unset; a small positive interval and a max below the interval are kept as written', () => {
    const unset: Record<string, unknown> = { id: 's', command: 'node', reconnect: true, reconnectIntervalMs: null, reconnectMaxIntervalMs: null };
    expect(checkReconnectTiming(unset)).toEqual([]);
    expect(unset).toEqual({ id: 's', command: 'node', reconnect: true, reconnectIntervalMs: null, reconnectMaxIntervalMs: null });
    const steady: Record<string, unknown> = { id: 's', url: 'ws://127.0.0.1:1/mcpl', reconnect: true, reconnectIntervalMs: 10_000, reconnectMaxIntervalMs: 5_000 };
    expect(checkReconnectTiming(steady)).toEqual([]);
    expect(steady).toMatchObject({ reconnectIntervalMs: 10_000, reconnectMaxIntervalMs: 5_000 });
    const quick: Record<string, unknown> = { id: 's', command: 'node', reconnect: true, reconnectIntervalMs: 1 };
    expect(checkReconnectTiming(quick)).toEqual([]);
    expect(quick.reconnectIntervalMs).toBe(1);
  });
});

describe('where the check runs', () => {
  test('a recipe or mcpl-servers.json entry that ends up reconnecting, by default or as written, is checked, with each note given its id; one with reconnect: false or null is not', () => {
    const notes: Array<[string, string]> = [];
    const merged = mergeRecipeServers(
      {
        defaulted: { command: 'node', reconnectIntervalMs: 0 },
        written: { command: 'node', reconnect: true, reconnectMaxIntervalMs: -1 },
        off: { command: 'node', reconnect: false, reconnectIntervalMs: 0 },
        unset: { command: 'node', reconnect: null, reconnectIntervalMs: 0 },
        named: { reconnectIntervalMs: 'soon' },
        fromFile: {},
      },
      [{ id: 'named', command: 'node' }, { id: 'fromFile', command: 'node', reconnectMaxIntervalMs: 0 }],
      (id, note) => notes.push([id, note]),
    );
    const byId = Object.fromEntries(merged.map((s) => [s.id, s]));
    expect('reconnectIntervalMs' in byId.defaulted!).toBe(false);
    expect('reconnectMaxIntervalMs' in byId.written!).toBe(false);
    expect(byId.off!.reconnectIntervalMs).toBe(0);
    expect(byId.unset!.reconnectIntervalMs).toBe(0);
    expect('reconnectIntervalMs' in byId.named!).toBe(false);
    expect('reconnectMaxIntervalMs' in byId.fromFile!).toBe(false);
    expect(notes).toEqual([
      ['defaulted', `its reconnectIntervalMs is 0, which isn't above 0, ${INTERVAL_DEFAULT}`],
      ['written', `its reconnectMaxIntervalMs is -1, which isn't above 0, ${MAX_DEFAULT}`],
      ['named', `its reconnectIntervalMs is text that doesn't read as a finite number, ${INTERVAL_DEFAULT}`],
      ['fromFile', `its reconnectMaxIntervalMs is 0, which isn't above 0, ${MAX_DEFAULT}`],
    ]);
  });

  test('without a callback the values are still dropped, as /bug composes them', () => {
    const [server] = mergeRecipeServers({ s: { command: 'node', reconnectIntervalMs: 0 } }, []);
    expect('reconnectIntervalMs' in server!).toBe(false);
  });

  test('an agent overlay entry that reconnects, by default or as written, is checked at the start, naming its id, and loads without the value; one with reconnect: false is not', () => {
    const path = overlayFile('{"mcplServers": {"mine": {"command": "node", "reconnectIntervalMs": 1e999}, "said": {"command": "node", "reconnect": true, "reconnectMaxIntervalMs": 0}, "still": {"command": "node", "reconnect": false, "reconnectIntervalMs": 0}}}');
    expect(overlayWarnings([], path)).toEqual([
      `[mcpl] server "mine": the agent overlay (${path}) entry loads, but its reconnectIntervalMs is Infinity, which isn't finite, ${INTERVAL_DEFAULT}`,
      `[mcpl] server "said": the agent overlay (${path}) entry loads, but its reconnectMaxIntervalMs is 0, which isn't above 0, ${MAX_DEFAULT}`,
    ]);
    expect('reconnectIntervalMs' in resolveOverlayEntry('mine', { command: 'node', reconnectIntervalMs: Infinity } as never)!).toBe(false);
    const said = startServers({}, [], path).servers.find((s) => s.id === 'said')!;
    expect(said).toMatchObject({ reconnect: true });
    expect('reconnectMaxIntervalMs' in said).toBe(false);
    expect(resolveOverlayEntry('still', { command: 'node', reconnect: false, reconnectIntervalMs: 0 } as never)!.reconnectIntervalMs).toBe(0);
  });

  test('the start warns of a recipe entry\'s dropped value only when that entry runs as composed: not when the agent overlay replaces or removes it', () => {
    const path = overlayFile('{"mcplServers": {"replaced": {"command": "node", "reconnectIntervalMs": 60000}, "removed": {"disabled": true}, "malformed": {"args": ["x"]}}}');
    const { operator, servers, warnings } = startServers(
      {
        kept: { command: 'node', reconnectIntervalMs: 0 },
        replaced: { command: 'node', reconnectIntervalMs: 0 },
        removed: { command: 'node', reconnectIntervalMs: 0 },
        malformed: { command: 'node', reconnectMaxIntervalMs: 0 },
      },
      [],
      path,
    );
    expect(warnings.filter((line) => !line.includes('agent overlay'))).toEqual([
      `[mcpl] server "kept": its reconnectIntervalMs is 0, which isn't above 0, ${INTERVAL_DEFAULT}`,
      `[mcpl] server "malformed": its reconnectMaxIntervalMs is 0, which isn't above 0, ${MAX_DEFAULT}`,
    ]);
    expect(warnings.some((line) => line.includes('server "malformed": the agent overlay') && line.includes('malformed'))).toBe(true);
    expect(operator.map((s) => s.id)).toEqual(['kept', 'replaced', 'removed', 'malformed']);
    expect(servers.map((s) => s.id)).toEqual(['kept', 'replaced', 'malformed']);
    expect('reconnectIntervalMs' in servers[0]!).toBe(false);
    expect(servers[1]!.reconnectIntervalMs).toBe(60000);
    expect('reconnectMaxIntervalMs' in servers[2]!).toBe(false);
  });
});
