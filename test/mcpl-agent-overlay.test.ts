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
  serverProvisions,
  lostByReplacement,
  overlayEntryReplaces,
  overlayWarnings,
  hostVariableReferences,
  AGENT_DEPLOY_DENIED_CAPABILITIES,
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
  const BASELINE = [...AGENT_DEPLOY_DENIED_CAPABILITIES].sort();

  test('tombstones and empty entries resolve to null', () => {
    expect(resolveOverlayEntry('x', { disabled: true }, '/tmp/o.json')).toBeNull();
    expect(resolveOverlayEntry('x', {}, '/tmp/o.json')).toBeNull();
  });

  test('url entries pass through with transport fields (plus the baseline capability mask)', () => {
    const r = resolveOverlayEntry('ws', { url: 'wss://host/mcpl', transport: 'websocket', token: 't' }, '/tmp/o.json');
    expect(r).toEqual({ id: 'ws', url: 'wss://host/mcpl', transport: 'websocket', token: 't', reconnect: true, disabledCapabilities: BASELINE });
  });

  test('disabled flag is stripped from resolved config', () => {
    const r = resolveOverlayEntry('s', { command: 'node', disabled: false }, '/tmp/o.json');
    expect(r).toEqual({ id: 's', command: 'node', disabledCapabilities: BASELINE });
  });

  // OpenAI-style strict function calling forces every schema property, so
  // agent tool calls arrive with [] where the caller meant "unspecified" —
  // and a PRESENT-empty allowlist is deny-all under the SPEC 0.5 pin (Mica's
  // silently eventless eidoverse, 2026-08-04). [] must carry no intent.
  test('empty allow/deny lists resolve as absent (strict-schema [] is "unspecified", never deny-all)', () => {
    const r = resolveOverlayEntry('e', {
      url: 'wss://host/mcpl',
      enabledFeatureSets: [],
      disabledFeatureSets: [],
      enabledTools: [],
      disabledTools: [],
    }, '/tmp/o.json');
    expect(r).toEqual({ id: 'e', url: 'wss://host/mcpl', reconnect: true, disabledCapabilities: BASELINE });
  });

  test('non-empty lists survive resolution', () => {
    const r = resolveOverlayEntry('e', { url: 'wss://x/mcpl', enabledFeatureSets: ['eidoverse.*'], enabledTools: ['*'] }, '/tmp/o.json');
    expect(r?.enabledFeatureSets).toEqual(['eidoverse.*']);
    expect(r?.enabledTools).toEqual(['*']);
  });

  test('self-deployed servers never get consequential capabilities: baseline mask covers context hooks, server-initiated inference, lifecycle, tool lifecycle', () => {
    expect(BASELINE).toEqual(['contextHooks', 'inferenceLifecycle', 'inferenceRequest', 'toolLifecycle']);
  });

  // A network server the agent deployed should come back when it bounces:
  // reconnect-defaulted-false left Mythos permanently severed from eidoverse
  // by a routine door deploy (2026-08-04) until his own next restart, days out.
  test('websocket entries default reconnect: true; explicit false is respected; stdio keeps no default', () => {
    expect(resolveOverlayEntry('a', { url: 'wss://x/mcpl' }, '/tmp/o.json')?.reconnect).toBe(true);
    expect(resolveOverlayEntry('b', { url: 'wss://x/mcpl', reconnect: false }, '/tmp/o.json')?.reconnect).toBe(false);
    expect(resolveOverlayEntry('c', { command: 'node' }, '/tmp/o.json')?.reconnect).toBeUndefined();
  });

  test('entry-supplied disabledCapabilities union with the baseline, never replace it', () => {
    const r = resolveOverlayEntry('e', { url: 'wss://x/mcpl', disabledCapabilities: ['channels.streaming'] } as never, '/tmp/o.json');
    expect(r?.disabledCapabilities).toEqual(['channels.streaming', ...BASELINE].sort());
  });

  test('enabledCapabilities is dropped — the agent overlay narrows, never widens (a hand-written entry could re-grant a §13.4 deny-by-default path)', () => {
    const r = resolveOverlayEntry('e', { url: 'wss://x/mcpl', enabledCapabilities: ['contextHooks.beforeInference.inject.system'] } as never, '/tmp/o.json');
    expect(r).not.toBeNull();
    expect('enabledCapabilities' in (r as object)).toBe(false);
  });
});

// An overlay entry replaces the operator's definition whole: its env is
// literal and it never inherits the host environment, so what the operator's
// definition provided and the entry lacks, the server runs without. A
// resident's shell came back from mcpl_restart without SESSION_SERVER_TOKEN
// that way (2026-10-08), and nothing said so until its first call.
describe('what an overlay replacement lacks of the operator definition', () => {
  const shell = {
    id: 'shell',
    command: 'node',
    args: ['/abs/terminal-sessions/mcp-stdio-server.js'],
    env: { SESSION_SERVER_TOKEN: 's3cret-token', SESSION_SERVER_PORT: '3101' },
  };

  test('serverProvisions keeps names, never values', () => {
    const p = serverProvisions({ ...shell, token: 'tok', access: ' eidoverse ', inheritEnv: true });
    expect(p).toEqual({ env: ['SESSION_SERVER_PORT', 'SESSION_SERVER_TOKEN'], token: true, access: 'eidoverse', inheritEnv: true });
    expect(JSON.stringify(p)).not.toContain('s3cret-token');
    expect(JSON.stringify(p)).not.toContain('tok"');
    expect(serverProvisions({ id: 'x', command: 'node', token: '', access: '  ' })).toEqual({ env: [], token: false, access: null, inheritEnv: false });
  });

  test('a command replacement lacks the env names it does not declare, and always the inherited host environment', () => {
    const operator = serverProvisions({ ...shell, inheritEnv: true });
    expect(lostByReplacement(operator, { command: 'node', args: ['other.js'] }))
      .toBe('env SESSION_SERVER_PORT, SESSION_SERVER_TOKEN; inherited host environment (inheritEnv)');
    expect(lostByReplacement(serverProvisions(shell), { command: 'node', env: { SESSION_SERVER_PORT: '3101' } }))
      .toBe('env SESSION_SERVER_TOKEN');
    // Declaring a name carries it, whatever its value.
    expect(lostByReplacement(serverProvisions(shell), { command: 'node', env: { SESSION_SERVER_PORT: '1', SESSION_SERVER_TOKEN: '' } }))
      .toBeNull();
  });

  test('a URL replacement lacks a token and an access grant, and env does not reach it', () => {
    const operator = serverProvisions({ id: 'world', url: 'wss://w/mcpl', token: 'tok', access: 'eidoverse', env: { A: '1' } });
    expect(lostByReplacement(operator, { url: 'wss://other/mcpl' })).toBe('token; access grant "eidoverse"');
    expect(lostByReplacement(operator, { url: 'wss://other/mcpl', token: 'mine', access: 'eidoverse' })).toBeNull();
    // A command replacement of a URL server: a token or grant can't reach a process.
    expect(lostByReplacement(operator, { command: 'node', env: { A: '1' } })).toBeNull();
  });

  // Greptile's review of #227: a name the host sets over any mapping
  // (AGENT_TIMEZONE) can't be lacking, and an access grant is a name, so
  // another name is another grant.
  test('a name the host sets over every mapping is never lacking', () => {
    const operator = serverProvisions({ ...shell, env: { ...shell.env, AGENT_TIMEZONE: 'UTC' } });
    expect(lostByReplacement(operator, { command: 'node', env: { SESSION_SERVER_PORT: '3101' } })).toBe('env SESSION_SERVER_TOKEN');
    expect(lostByReplacement(serverProvisions({ id: 'tz', command: 'node', env: { AGENT_TIMEZONE: 'UTC' } }), { command: 'node' })).toBeNull();
    // The reaction baseline is a default the server's own mapping overrides, so it can be lacking.
    expect(lostByReplacement(serverProvisions({ id: 'd', command: 'node', env: { DISCORD_SUPPRESSED_REACTIONS_BASELINE: 'x' } }), { command: 'node' }))
      .toBe('env DISCORD_SUPPRESSED_REACTIONS_BASELINE');
  });

  test('another access grant name lacks the operator\'s grant', () => {
    const operator = serverProvisions({ id: 'world', url: 'wss://w/mcpl', access: 'eidoverse' });
    expect(lostByReplacement(operator, { url: 'wss://w/mcpl', access: 'eidoveres' })).toBe('access grant "eidoverse"');
    expect(lostByReplacement(operator, { url: 'wss://w/mcpl', access: ' eidoverse ' })).toBeNull();
  });

  // Greptile's review of #228: the boot asks for the grant as the overlay
  // resolves it, so a hand-edited name the warnings read as the operator's
  // must resolve to that name.
  test('the grant a replacement is read as carrying is the grant the boot dials', () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      saveAgentOverlay(path, { world: { url: 'wss://w/mcpl', access: ' eidoverse ' } });
      const operatorServers = [{ id: 'world', url: 'wss://w/mcpl', access: 'eidoverse' }];
      expect(overlayWarnings(operatorServers, path)).toEqual([]);
      expect(applyAgentOverlay(operatorServers, path)[0]?.access).toBe('eidoverse');
    });
  });

  // Nell-1783's review of c1e33ec: agent-framework chooses the connection by
  // `transport` first (isWebSocketTransport), so a hand-edited entry with a
  // command and a URL under transport "websocket" dials the URL.
  test('an entry is read by the connection the framework opens for it', () => {
    const operator = serverProvisions({ id: 'world', url: 'wss://w/mcpl', token: 'tok', access: 'eidoverse' });
    const dialled = { command: 'node', url: 'wss://w/mcpl', transport: 'websocket' as const, env: { A: '${A}' }, token: '${TOKEN}' };
    expect(lostByReplacement(operator, dialled)).toBe('token; access grant "eidoverse"');
    expect(hostVariableReferences(dialled)).toEqual(['token']);
    // An explicit stdio transport spawns the command, as a command alone does.
    const spawned = { command: 'node', url: 'wss://w/mcpl', transport: 'stdio' as const, env: { A: '${A}' }, token: '${TOKEN}' };
    expect(lostByReplacement(serverProvisions({ id: 'shell', command: 'node', env: { A: '1' } }), spawned)).toBe('env A');
    expect(hostVariableReferences(spawned)).toEqual(['env A']);
    // A stdio transport with no command spawns nothing and dials nothing.
    expect(lostByReplacement(operator, { url: 'wss://w/mcpl', transport: 'stdio', token: '${TOKEN}' })).toBeNull();
    expect(hostVariableReferences({ url: 'wss://w/mcpl', transport: 'stdio', token: '${TOKEN}' })).toEqual([]);
    // Nor does a websocket transport with no url: the framework refuses to dial.
    expect(lostByReplacement(operator, { command: 'node', transport: 'websocket', token: '${TOKEN}' })).toBeNull();
    expect(hostVariableReferences({ command: 'node', transport: 'websocket', token: '${TOKEN}' })).toEqual([]);
  });

  // Nell-1783's review of the fix: the overlay is hand-editable JSON, so a
  // malformed shape must read as lacking, never throw, since the startup
  // warnings run before the overlay is applied.
  test('malformed entry shapes read as lacking and never throw', () => {
    withTmp((dir) => {
      const operator = serverProvisions({ id: 'world', url: 'wss://w/mcpl', access: 'portal' });
      const malformed = { url: 'wss://w/mcpl', access: 5 } as unknown as AgentOverlayEntry;
      expect(lostByReplacement(operator, malformed)).toBe('access grant "portal"');
      const odd = { command: 'node', args: 'not-a-list', env: ['${A}'] } as unknown as AgentOverlayEntry;
      expect(hostVariableReferences(odd)).toEqual([]);
      expect(lostByReplacement(serverProvisions(shell), odd)).toBe('env SESSION_SERVER_PORT, SESSION_SERVER_TOKEN');
      const path = join(dir, 'mcpl-servers.agent.json');
      writeFileSync(path, JSON.stringify({ mcplServers: { world: malformed, shell: odd } }));
      expect(() => overlayWarnings([shell, { id: 'world', url: 'wss://w/mcpl', access: 'portal' }], path)).not.toThrow();
    });
  });

  test('only an entry that puts a server in place replaces one', () => {
    expect(overlayEntryReplaces(undefined)).toBe(false);
    expect(overlayEntryReplaces({ disabled: true })).toBe(false);
    expect(overlayEntryReplaces({ env: { A: '1' } })).toBe(false);
    expect(overlayEntryReplaces({ command: 'node' })).toBe(true);
    expect(overlayEntryReplaces({ url: 'wss://x' })).toBe(true);
  });

  test('the startup warnings name each replacement that lacks something, and each host-variable reference', () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      saveAgentOverlay(path, {
        shell: { command: 'node', args: ['mine.js'] },                 // lacks the token
        discord: { command: 'node', env: { DISCORD_TOKEN: 'x' } },     // carries everything
        heartbeat: { disabled: true },                                  // a tombstone, not a replacement
        mytool: { command: 'bun', env: { API_KEY: '${API_KEY}' } },     // the operator has no "mytool"; a literal reference
      });
      const operatorServers = [
        shell,
        { id: 'discord', command: 'node', env: { DISCORD_TOKEN: 'real' } },
        { id: 'heartbeat', command: 'node', env: { HEARTBEAT_CONFIG_FILE: '/x' } },
      ];
      const lines = overlayWarnings(operatorServers, path);
      expect(lines).toEqual([
        `[mcpl] server "shell": the agent overlay (${path}) replaces the operator's definition and lacks its ` +
        'env SESSION_SERVER_PORT, SESSION_SERVER_TOKEN, so the server runs without the operator\'s values for them',
        `[mcpl] server "mytool": the agent overlay (${path}) names a host variable in its env API_KEY, which only ` +
        'a recipe substitutes, so the server gets that text as written',
      ]);
      expect(lines.join('\n')).not.toContain('s3cret-token');
      expect(overlayWarnings(operatorServers, join(dir, 'none.json'))).toEqual([]);
    });
  });

  // The receipt says an overlay entry can't name host variables, but the
  // likeliest next move is to write one anyway: `${VAR}` there reaches the
  // child as literal text, so it supplies nothing (Nell-1783's review).
  test('a value that names a host variable supplies nothing, and is named, never shown', () => {
    expect(lostByReplacement(serverProvisions(shell), {
      command: 'node',
      env: { SESSION_SERVER_PORT: '3101', SESSION_SERVER_TOKEN: '${SESSION_SERVER_TOKEN}' },
    })).toBe('env SESSION_SERVER_TOKEN');
    expect(lostByReplacement(serverProvisions(shell), {
      command: 'node',
      env: { SESSION_SERVER_PORT: '3101', SESSION_SERVER_TOKEN: 'prefix-${SESSION_SERVER_TOKEN:-x}' },
    })).toBe('env SESSION_SERVER_TOKEN');
    const world = serverProvisions({ id: 'world', url: 'wss://w/mcpl', token: 'tok' });
    expect(lostByReplacement(world, { url: 'wss://w/mcpl', token: '${WORLD_TOKEN}' })).toBe('token');

    expect(hostVariableReferences({
      command: '${TOOLS}/server',
      args: ['--key', '${KEY}'],
      env: { B: '${B}', A: '$NOT_A_REFERENCE', C: '${C:-}' },
    })).toEqual(['command', 'args', 'env B', 'env C']);
    expect(hostVariableReferences({ url: 'wss://${HOST}/mcpl', token: '${T}', env: { E: '${E}' } })).toEqual(['url', 'token']);
    expect(hostVariableReferences({ command: 'node', args: ['a.js'], env: { A: 'literal' } })).toEqual([]);
  });
});
