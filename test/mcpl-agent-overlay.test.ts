/**
 * Agent overlay (mcpl-servers.agent.json) — persistence and merge semantics
 * for agent-deployed MCPL servers.
 */

import { test, expect, describe } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  readAgentOverlay,
  saveAgentOverlay,
  applyAgentOverlay,
  resolveOverlayEntry,
  type AgentOverlayEntry,
} from '../src/mcpl-config.js';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'agent-overlay-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('readAgentOverlay / saveAgentOverlay', () => {
  test('missing file reads as empty object', () => {
    withTmp((dir) => {
      expect(readAgentOverlay(join(dir, 'nope.json'))).toEqual({});
    });
  });

  test('round-trips entries', () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      const entries: Record<string, AgentOverlayEntry> = {
        mytool: { command: 'node', args: ['server.js'] },
        discord: { disabled: true },
      };
      saveAgentOverlay(path, entries);
      expect(readAgentOverlay(path)).toEqual(entries);
    });
  });
});

describe('applyAgentOverlay', () => {
  const base = [
    { id: 'discord', command: 'node', args: ['/abs/discord.js'] },
    { id: 'heartbeat', command: 'node', args: ['/abs/heartbeat.js'] },
  ];

  test('no overlay file → servers unchanged', () => {
    withTmp((dir) => {
      const result = applyAgentOverlay(base, join(dir, 'nope.json'));
      expect(result).toEqual(base);
    });
  });

  test('tombstone removes a recipe server', () => {
    withTmp((dir) => {
      const path = join(dir, 'overlay.json');
      saveAgentOverlay(path, { discord: { disabled: true } });
      const result = applyAgentOverlay(base, path);
      expect(result.map(s => s.id)).toEqual(['heartbeat']);
    });
  });

  test('overlay entry replaces an existing server in place', () => {
    withTmp((dir) => {
      const path = join(dir, 'overlay.json');
      saveAgentOverlay(path, { heartbeat: { command: 'bun', args: ['new.ts'] } });
      const result = applyAgentOverlay(base, path);
      expect(result.map(s => s.id)).toEqual(['discord', 'heartbeat']);
      const hb = result.find(s => s.id === 'heartbeat') as Record<string, unknown>;
      expect(hb.command).toBe('bun');
    });
  });

  test('new overlay entry is appended', () => {
    withTmp((dir) => {
      const path = join(dir, 'overlay.json');
      saveAgentOverlay(path, { mytool: { command: 'node', args: ['tool.js'] } });
      const result = applyAgentOverlay(base, path);
      expect(result.map(s => s.id)).toEqual(['discord', 'heartbeat', 'mytool']);
    });
  });

  test('relative args resolve against the overlay directory', () => {
    withTmp((dir) => {
      const path = join(dir, 'overlay.json');
      saveAgentOverlay(path, { mytool: { command: 'node', args: ['./servers/tool.js', '--flag'] } });
      const result = applyAgentOverlay(base, path);
      const tool = result.find(s => s.id === 'mytool') as { args: string[] };
      expect(tool.args[0]).toBe(resolve(dir, './servers/tool.js'));
      expect(tool.args[1]).toBe('--flag');
    });
  });

  test('entries with neither command nor url are skipped (corrupt tombstone-ish)', () => {
    withTmp((dir) => {
      const path = join(dir, 'overlay.json');
      writeFileSync(path, JSON.stringify({ mcplServers: { broken: { env: { A: '1' } } } }));
      const result = applyAgentOverlay(base, path);
      expect(result.map(s => s.id)).toEqual(['discord', 'heartbeat']);
    });
  });
});

describe('resolveOverlayEntry', () => {
  test('tombstones and empty entries resolve to null', () => {
    expect(resolveOverlayEntry('x', { disabled: true }, '/tmp/o.json')).toBeNull();
    expect(resolveOverlayEntry('x', {}, '/tmp/o.json')).toBeNull();
  });

  test('url entries pass through with transport fields', () => {
    const r = resolveOverlayEntry('ws', { url: 'wss://host/mcpl', transport: 'websocket', token: 't' }, '/tmp/o.json');
    expect(r).toEqual({ id: 'ws', url: 'wss://host/mcpl', transport: 'websocket', token: 't' });
  });

  test('disabled flag is stripped from resolved config', () => {
    const r = resolveOverlayEntry('s', { command: 'node', disabled: false }, '/tmp/o.json');
    expect(r).toEqual({ id: 's', command: 'node' });
  });
});
