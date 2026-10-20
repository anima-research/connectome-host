/**
 * Agent overlay (mcpl-servers.agent.json) — persistence and merge semantics
 * for agent-deployed MCPL servers.
 */

import { test, expect, describe } from 'bun:test';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  readAgentOverlay,
  saveAgentOverlay,
  saveMcplServers,
  readMcplServersFile,
  loadMcplServers,
  applyAgentOverlay,
  resolveOverlayEntry,
  serverProvisions,
  lostByReplacement,
  overlayEntryProblem,
  overlayEntryReplaces,
  overlayEntryTombstones,
  overlayWarnings,
  hostVariableReferences,
  loadMcplServers,
  mergeRecipeServers,
  AGENT_DEPLOY_DENIED_CAPABILITIES,
  OPERATOR_ONLY_OVERLAY_FIELDS,
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

  // JSON.parse's own message names no file, and can quote the text (Bun
  // names the token it didn't expect, V8 quotes a stretch), which can hold
  // credentials: the boot, the operator's /mcp commands and mcpl_list
  // showed it. A root of null threw a TypeError naming nothing.
  test("the operator's servers file that isn't JSON, or holds null, is named and never quoted, at the boot and in an edit", () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.json');
      writeFileSync(path, '{ "mcplServers": { "chat": { "env": { "TOKEN": s3cret } } } }');
      for (const read of [readMcplServersFile, loadMcplServers]) {
        expect(() => read(path)).toThrow(`${path} isn't valid JSON`);
        try { read(path); } catch (error) {
          // Still a SyntaxError, the class a bug report names.
          expect(error).toBeInstanceOf(SyntaxError);
          expect(String(error)).not.toContain('s3cret');
        }
      }
      writeFileSync(path, 'null');
      for (const read of [readMcplServersFile, loadMcplServers]) {
        expect(() => read(path)).toThrow(`${path} holds null, not an object with mcplServers`);
        // A TypeError, as main threw for it, unnamed.
        expect(() => read(path)).toThrow(TypeError);
      }
    });
  });

  // Each check of the strict reading joins the others, so a regression to
  // stopping at the first problem fails here.
  test('the strict reading names every problem of an entry at once, a list read for an empty name whatever else it holds', () => {
    expect(overlayEntryProblem(
      { command: 5, transport: 'ws', args: 'x', env: { A: null }, enabledTools: [1, ''], reconnect: 'yes' },
      { strict: true },
    )).toBe(
      "its command isn't text; its transport is neither stdio nor websocket; its args aren't a list of text; its env A " +
      "isn't text, a finite number or true/false; its enabledTools isn't a list of names; its enabledTools holds an empty name, " +
      'which matches nothing; its reconnect is neither true nor false',
    );
  });

  // Both servers files keep the root's other keys on a save; a root that
  // isn't an object holds no entries and is replaced; and a file that
  // doesn't parse is refused, never overwritten.
  test("a save keeps the root's other keys, replaces a root that isn't an object, and never overwrites a file that doesn't parse", () => {
    withTmp((dir) => {
      const overlay = join(dir, 'mcpl-servers.agent.json');
      const operator = join(dir, 'mcpl-servers.json');
      writeFileSync(operator, JSON.stringify({ $comment: 'shared', mcpServers: { typo: {} }, mcplServers: {} }));
      saveMcplServers(operator, { chat: { command: 'node' } });
      expect(JSON.parse(readFileSync(operator, 'utf-8'))).toEqual({
        $comment: 'shared', mcpServers: { typo: {} }, mcplServers: { chat: { command: 'node' } },
      });
      writeFileSync(overlay, JSON.stringify(['not', 'an', 'overlay']));
      saveAgentOverlay(overlay, { mine: { command: 'bun' } });
      expect(JSON.parse(readFileSync(overlay, 'utf-8'))).toEqual({ mcplServers: { mine: { command: 'bun' } } });
      writeFileSync(overlay, '{ "token": "secret-value", not json');
      expect(() => saveAgentOverlay(overlay, {})).toThrow(`${overlay} isn't valid JSON, so it wasn't overwritten`);
      expect(readFileSync(overlay, 'utf-8')).toBe('{ "token": "secret-value", not json');
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

  test("every operator-only field is dropped, allowHostCommands among them: the agent's file narrows, never widens", () => {
    const r = resolveOverlayEntry('e', {
      command: 'node', allowHostCommands: true, inheritEnv: true,
      enabledCapabilities: ['contextHooks.beforeInference.inject.system'], toolLifecycle: { observe: ['*'] },
    } as never, '/tmp/o.json');
    expect(r).not.toBeNull();
    // By name, so a field taken off the list fails here.
    for (const k of ['allowHostCommands', 'inheritEnv', 'enabledCapabilities', 'toolLifecycle']) {
      expect({ k, kept: k in (r as object) }).toEqual({ k, kept: false });
    }
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
    // The operator's grant as the boot dials it, untrimmed.
    expect(p).toEqual({ env: ['SESSION_SERVER_PORT', 'SESSION_SERVER_TOKEN'], token: true, access: ' eidoverse ', inheritEnv: true, grants: [] });
    expect(JSON.stringify(p)).not.toContain('s3cret-token');
    expect(JSON.stringify(p)).not.toContain('tok"');
    expect(serverProvisions({ id: 'x', command: 'node', token: '', access: '' })).toEqual({ env: [], token: false, access: null, inheritEnv: false, grants: [] });
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

  test("any replacement lacks the operator's other grants, which no overlay entry can carry", () => {
    const operator = serverProvisions({
      id: 's', command: 'node', inheritEnv: true,
      enabledCapabilities: ['contextHooks'], toolLifecycle: { observe: {} }, allowHostCommands: true,
    });
    expect(operator.grants).toEqual(['enabledCapabilities', 'toolLifecycle', 'allowHostCommands']);
    const grants = 'enabled capabilities (enabledCapabilities); tool lifecycle (toolLifecycle); host commands (allowHostCommands)';
    expect(lostByReplacement(operator, { command: 'node', allowHostCommands: true } as never))
      .toBe(`inherited host environment (inheritEnv); ${grants}`);
    expect(lostByReplacement(operator, { url: 'wss://w/mcpl' })).toBe(grants);
    // A definition whose grants are off grants nothing to lose.
    expect(serverProvisions({ id: 's', command: 'node', allowHostCommands: false, toolLifecycle: null }).grants).toEqual([]);
    expect(lostByReplacement(serverProvisions({ id: 's', command: 'node', allowHostCommands: false }), { command: 'node' })).toBeNull();
    // An empty capabilities list is a mask that lets nothing through, which
    // a replacement lacks.
    expect(serverProvisions({ id: 's', command: 'node', enabledCapabilities: [] }).grants).toEqual(['enabledCapabilities']);
    expect(lostByReplacement(serverProvisions({ id: 's', command: 'node', enabledCapabilities: [] }), { command: 'node' }))
      .toBe('enabled capabilities (enabledCapabilities)');
  });

  test("a definition's setting counts only as agent-framework 0.22.3 would read it", () => {
    const grants = (fields: Record<string, unknown>) => serverProvisions({ id: 's', command: 'node', ...fields }).grants;
    // Host commands only for true; capabilities for any list, a mask even
    // when empty; tool lifecycle for an observe or inputs policy object.
    expect(grants({ allowHostCommands: true })).toEqual(['allowHostCommands']);
    expect(grants({ enabledCapabilities: ['contextHooks'] })).toEqual(['enabledCapabilities']);
    expect(grants({ enabledCapabilities: [] })).toEqual(['enabledCapabilities']);
    expect(grants({ toolLifecycle: { observe: {} } })).toEqual(['toolLifecycle']);
    expect(grants({ toolLifecycle: { inputs: {} } })).toEqual(['toolLifecycle']);
    // Values the framework grants nothing from, or can't read (a
    // capabilities value that isn't a list): no setting a replacement lacks.
    for (const fields of [
      { allowHostCommands: 'true' }, { allowHostCommands: 1 }, { allowHostCommands: {} },
      { enabledCapabilities: 'contextHooks' }, { enabledCapabilities: {} },
      { toolLifecycle: {} }, { toolLifecycle: { maxInputBytes: 100 } }, { toolLifecycle: { observe: true } }, { toolLifecycle: [] },
      { toolLifecycle: { observe: [] } }, { toolLifecycle: { inputs: [] } },
    ]) {
      expect({ fields, grants: grants(fields) }).toEqual({ fields, grants: [] });
      expect(lostByReplacement(serverProvisions({ id: 's', command: 'node', ...fields }), { command: 'node' })).toBeNull();
    }
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
    // The host sets no reaction baseline, so a value the entry gave is simply lost on replacement.
    expect(lostByReplacement(serverProvisions({ id: 'd', command: 'node', env: { DISCORD_SUPPRESSED_REACTIONS_BASELINE: 'x' } }), { command: 'node' }))
      .toBe('env DISCORD_SUPPRESSED_REACTIONS_BASELINE');
  });

  test('another access grant name lacks the operator\'s grant', () => {
    const operator = serverProvisions({ id: 'world', url: 'wss://w/mcpl', access: 'eidoverse' });
    expect(lostByReplacement(operator, { url: 'wss://w/mcpl', access: 'eidoveres' })).toBe('access grant "eidoverse"');
    // The boot dials a grant as written, as main did, so a padded name is
    // another audience.
    expect(lostByReplacement(operator, { url: 'wss://w/mcpl', access: ' eidoverse ' })).toBe('access grant "eidoverse"');
    expect(lostByReplacement(operator, { url: 'wss://w/mcpl', access: 'eidoverse' })).toBeNull();
  });

  // Greptile's review of #228: the boot asks for the grant as the overlay
  // resolves it, so the warnings must compare that same name. Main passed it
  // as written, and so does the boot again.
  test('the grant a replacement is read as carrying is the grant the boot dials', () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      saveAgentOverlay(path, { world: { url: 'wss://w/mcpl', access: ' eidoverse ' } });
      const operatorServers = [{ id: 'world', url: 'wss://w/mcpl', access: 'eidoverse' }];
      expect(applyAgentOverlay(operatorServers, path)[0]?.access).toBe(' eidoverse ');
      expect(overlayWarnings(operatorServers, path)).toEqual([
        `[mcpl] server "world": the agent overlay (${path}) replaces the operator's definition and lacks its ` +
        'access grant "eidoverse", so the server runs without the operator\'s values for them',
      ]);
    });
  });

  // Agent-framework chooses the connection by
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

  // The overlay is hand-editable JSON, so an
  // odd shape must never throw, since the startup warnings run before the
  // overlay is applied. Each is read as the boot passes it on.
  test('odd entry shapes are read as the boot passes them on, and never throw', () => {
    withTmp((dir) => {
      const operator = serverProvisions({ id: 'world', url: 'wss://w/mcpl', access: 'portal' });
      // An access that isn't text passes on as main passed it, and the boot
      // asks for no grant for it, so the replacement lacks the operator's.
      const numberAccess = { url: 'wss://w/mcpl', access: 5 } as unknown as AgentOverlayEntry;
      expect(lostByReplacement(operator, numberAccess)).toBe('access grant "portal"');
      // A number token goes on the dial as its text, as main sent it, so it
      // isn't lacking.
      const withToken = serverProvisions({ id: 'world', url: 'wss://w/mcpl', token: 'tok' });
      expect(lostByReplacement(withToken, { url: 'wss://w/mcpl', token: 7 } as unknown as AgentOverlayEntry)).toBeNull();
      expect(lostByReplacement(withToken, { url: 'wss://w/mcpl', token: '' })).toBe('token');
      // The operator's side reads its token the same way, so a number token
      // a replacement drops is lacking.
      const numberToken = serverProvisions({ id: 'world', url: 'wss://w/mcpl', token: 12345 });
      expect(numberToken.token).toBe(true);
      expect(lostByReplacement(numberToken, { url: 'wss://w/mcpl' })).toBe('token');
      // Args that aren't a list stopped main's start, so the boot skips the
      // entry: it replaces nothing, so it lacks nothing and names nothing.
      const odd = { command: 'node', args: 'not-a-list', env: ['${A}'] } as unknown as AgentOverlayEntry;
      expect(hostVariableReferences(odd)).toEqual([]);
      expect(lostByReplacement(serverProvisions(shell), odd)).toBeNull();
      const path = join(dir, 'mcpl-servers.agent.json');
      writeFileSync(path, JSON.stringify({ mcplServers: { world: numberAccess, shell: odd } }));
      expect(() => overlayWarnings([shell, { id: 'world', url: 'wss://w/mcpl', access: 'portal' }], path)).not.toThrow();
      // A parsed object whose own toString isn't a function makes String()
      // throw: an env value passes on as written, and such a
      // capability names nothing. Every other capability reads as main's
      // String() read it, so a nested list still denies its name.
      writeFileSync(path, JSON.stringify({ mcplServers: {
        unprintable: { command: 'node', env: { A: { toString: 1 } }, disabledCapabilities: [{ toString: 1 }, ['memory'], 'channels'] },
      } }));
      // Main stopped the start on that item, so the reading differs and is named.
      expect(overlayWarnings([], path)).toEqual([
        `[mcpl] server "unprintable": the agent overlay (${path}) entry loads, but its disabledCapabilities holds an item that can't be read as text, which denies nothing, where the host used to stop the start`,
      ]);
      const [loaded] = applyAgentOverlay([], path) as Array<Record<string, unknown>>;
      expect(loaded!.disabledCapabilities).toEqual([...AGENT_DEPLOY_DENIED_CAPABILITIES, 'channels', 'memory'].sort());
    });
  });

  // The boot's own reader threw on a null
  // entry and on non-array args, so the host didn't start; and the readers
  // disagreed on a non-boolean `disabled`. An entry the boot skips is now
  // skipped by every reader alike: one main stopped on, and one main skipped
  // silently (a truthy `disabled` that isn't true loaded nothing on main and
  // unloaded nothing).
  test('a malformed entry is skipped by the boot and every reader alike, and nothing throws', () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      const entries: Record<string, unknown> = {
        nulled: null,
        stringArgs: { command: 'node', args: 'server.js' },
        nullArg: { command: 'node', args: [null] },
        yes: { command: 'node', disabled: 'yes' },
        seven: 7,
      };
      writeFileSync(path, JSON.stringify({ mcplServers: entries }));
      const operator = Object.keys(entries).map((id) => ({ id, command: 'operator-mcpl' }));
      // The boot: every operator definition stays, and nothing is added.
      expect(applyAgentOverlay(operator, path)).toEqual(operator);
      for (const [id, entry] of Object.entries(entries)) {
        expect(resolveOverlayEntry(id, entry as AgentOverlayEntry, path)).toBeNull();
        expect(overlayEntryReplaces(entry)).toBe(false);
        expect(overlayEntryTombstones(entry)).toBe(false);
      }
      expect(overlayWarnings(operator, path)).toEqual([
        `[mcpl] server "nulled": the agent overlay (${path}) entry is malformed (it isn't an object), so the boot skips it and the operator's definition loads`,
        `[mcpl] server "stringArgs": the agent overlay (${path}) entry is malformed (its args aren't a list of text, numbers or true/false), so the boot skips it and the operator's definition loads`,
        `[mcpl] server "nullArg": the agent overlay (${path}) entry is malformed (its args aren't a list of text, numbers or true/false), so the boot skips it and the operator's definition loads`,
        `[mcpl] server "yes": the agent overlay (${path}) entry is malformed (its disabled is neither true nor false), so the boot skips it and the operator's definition loads`,
        `[mcpl] server "seven": the agent overlay (${path}) entry is malformed (it isn't an object), so the boot skips it and the operator's definition loads`,
      ]);
      // With no operator definition, the line says only that the boot skips it.
      expect(overlayWarnings([], path)[0]).toBe(`[mcpl] server "nulled": the agent overlay (${path}) entry is malformed (it isn't an object), so the boot skips it`);
    });
  });

  // Main's own mcpl_deploy saved env values
  // as given, so a file it wrote can hold a number. That entry loads today,
  // and #228 must not make the boot skip it. The boot passes the env on as
  // main did, and the child gets each value's text when it's spawned.
  test("an entry as main's mcpl_deploy wrote it, with a number in its env, loads as main loaded it", () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      // main's deploy saved args as text (map(String)) and env as given.
      const written = { command: 'node', args: ['server.js'], env: { PORT: 3101, VERBOSE: true, NAME: 'door' } };
      writeFileSync(path, JSON.stringify({ mcplServers: { door: written } }));
      expect(overlayEntryProblem(written)).toBeNull();
      const loaded = applyAgentOverlay([], path);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({ id: 'door', command: 'node', args: ['server.js'], env: written.env });
      expect(overlayWarnings([], path)).toEqual([]);
      // The stored entry is read, never rewritten.
      expect(JSON.parse(readFileSync(path, 'utf8')).mcplServers.door).toEqual(written);
    });
  });

  // Main passed these shapes to the framework, which starts each
  // server on its own and logs one that fails, so a file that worked keeps
  // working. Each reaches the framework as main passed it, with no note.
  test('shapes main passed on reach the framework as main passed them', () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      const entries: Record<string, Record<string, unknown>> = {
        oddEnv: { command: 'node', env: { A: null, B: { b: 1 }, C: ['x', 'y'], D: 'plain' } },
        emptyEnv: { command: 'node', env: [] },
        listEnv: { command: 'node', env: ['A=1'] },
        nullFields: { command: 'node', token: null, url: null, access: null, args: null, env: null, transport: null },
        disabledZero: { command: 'node', disabled: 0 },
        disabledBlank: { command: 'node', disabled: '' },
        numberAccess: { url: 'wss://w/mcpl', access: 5, token: 7 },
        numberCommand: { command: 5 },
        blankTools: { command: 'node', enabledTools: '' },
        wsNoUrl: { command: 'node', transport: 'websocket' },
      };
      writeFileSync(path, JSON.stringify({ mcplServers: entries }));
      for (const entry of Object.values(entries)) expect(overlayEntryProblem(entry)).toBeNull();
      const loaded = new Map(applyAgentOverlay([], path).map((s) => [s.id, s as Record<string, unknown>]));
      expect([...loaded.keys()]).toEqual(Object.keys(entries));
      for (const [id, entry] of Object.entries(entries)) {
        const { disabled: _d, ...fields } = entry;
        expect(loaded.get(id)).toMatchObject(fields);
      }
      // A falsy disabled loads the entry, as main's resolveOverlayEntry read it.
      expect('disabled' in loaded.get('disabledZero')!).toBe(false);
      // A blank list passes on blank, which the framework reads as no restriction.
      expect(loaded.get('blankTools')!.enabledTools).toBe('');
      // Only the entry the framework can't open is named, though it loads as
      // on main.
      expect(overlayWarnings([], path)).toEqual([
        `[mcpl] server "wsNoUrl": the agent overlay (${path}) entry loads, but its transport is websocket, with no url to dial, so the framework can't open it`,
      ]);
    });
  });

  // Where main's own handling broke on a shape, the boot reads it the way
  // that works, and the startup log names each such reading.
  test('where main broke on a shape, the reading that works is used and named', () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      const entries: Record<string, Record<string, unknown>> = {
        numberArgs: { command: 'node', args: ['server.js', 8080, true] },
        numberPrefix: { command: 'node', toolPrefix: 5 },
        truePrefix: { command: 'node', toolPrefix: true },
        objectPrefix: { command: 'node', toolPrefix: { p: 1 } },
        oneName: { command: 'node', disabledTools: 'shell_exec' },
        oneCapability: { command: 'node', disabledCapabilities: 'channels' },
        wsTransport: { transport: 'ws', url: 'wss://w/mcpl' },
        stdioNoCommand: { transport: 'stdio', url: 'wss://w/mcpl' },
      };
      writeFileSync(path, JSON.stringify({ mcplServers: entries }));
      const loaded = new Map(applyAgentOverlay([], path).map((s) => [s.id, s as Record<string, unknown>]));
      expect(loaded.get('numberArgs')!.args).toEqual(['server.js', '8080', 'true']);
      expect(loaded.get('numberPrefix')!.toolPrefix).toBe('5');
      expect(loaded.get('truePrefix')!.toolPrefix).toBe('true');
      // An object has no text either, so the default prefix routes its tools.
      expect('toolPrefix' in loaded.get('objectPrefix')!).toBe(false);
      expect(loaded.get('oneName')!.disabledTools).toEqual(['shell_exec']);
      expect(loaded.get('oneCapability')!.disabledCapabilities).toEqual([...AGENT_DEPLOY_DENIED_CAPABILITIES, 'channels'].sort());
      // The framework ignores a transport it doesn't know, so a url with no
      // command dials; the transport passes on as written.
      expect(loaded.get('wsTransport')).toMatchObject({ transport: 'ws', url: 'wss://w/mcpl', reconnect: true });
      const lines = overlayWarnings([], path);
      const loads = (id: string) => `[mcpl] server "${id}": the agent overlay (${path}) entry loads, but`;
      expect(lines).toEqual([
        `${loads('numberArgs')} its args hold numbers or true/false, read as their text, where the host used to stop the start`,
        `${loads('numberPrefix')} its toolPrefix is a number, read as its text, so calls to its tools reach it`,
        `${loads('truePrefix')} its toolPrefix is true or false, read as its text, so calls to its tools reach it`,
        `${loads('objectPrefix')} its toolPrefix isn't text, so its tools take the default prefix, which calls to them reach`,
        `${loads('oneName')} its disabledTools is one name, read as a list of one`,
        `${loads('oneCapability')} its disabledCapabilities is one name, read as a list of one`,
        `${loads('wsTransport')} its transport is neither stdio nor websocket, so the framework ignores it`,
        // Passed on as main passed it, and named, since it replaces any
        // operator definition with nothing that connects.
        `${loads('stdioNoCommand')} its transport is stdio, with no command to spawn, so the framework can't open it`,
      ]);
      // No line quotes a value from the file.
      expect(lines.join('\n')).not.toContain('"ws"');
    });
  });

  test('a new write is held to the plain shapes the boot reads leniently (strict)', () => {
    for (const [entry, problem] of [
      [{ command: 'node', env: { A: null } }, "its env A isn't text, a finite number or true/false"],
      [{ command: 'node', env: { A: ['x'], B: {} } }, "its env A, B aren't text, a finite number or true/false"],
      [{ transport: 'ws', url: 'wss://w/mcpl' }, 'its transport is neither stdio nor websocket'],
      [{ command: 'node', toolPrefix: 5 }, "its toolPrefix isn't text"],
    ] as const) {
      expect(overlayEntryProblem(entry, { strict: true })).toBe(problem);
      expect(overlayEntryProblem(entry)).toBeNull();
    }
  });

  // A number JSON can't write (a file's 1e400 parses as Infinity) is refused
  // for a new write, which would save null in its place, while the boot reads
  // args as main did: every number as its text.
  test('a number JSON can\'t write is refused for a new write, and read as its text in the boot\'s args', () => {
    expect(overlayEntryProblem({ command: 'node', env: { BIG: Infinity } }, { strict: true }))
      .toBe("its env BIG isn't text, a finite number or true/false");
    expect(overlayEntryProblem({ command: 'node', args: ['--size', 1e400] })).toBeNull();
    expect(resolveOverlayEntry('big', { command: 'node', args: ['--size', 1e400] } as AgentOverlayEntry, '/o.json')?.args)
      .toEqual(['--size', 'Infinity']);
  });

  // A wrong kind is refused for a new write, and the boot passes it on as
  // main passed it, since the framework starts each server on its own.
  test('a wrong kind is refused for a new write, and passes on at the boot as main passed it', () => {
    for (const [entry, problem] of [
      [{ command: 5 }, "its command isn't text"],
      [{ url: ['wss://w'] }, "its url isn't text"],
      [{ url: 'wss://w', token: 7 }, "its token isn't text"],
      [{ url: 'wss://w', access: 5 }, "its access isn't text"],
      [{ command: 'node', toolPrefix: { p: 1 } }, "its toolPrefix isn't text"],
      [{ command: 'node', args: ['a.js', 1] }, "its args aren't a list of text"],
      [{ command: 'node', env: 'A=1' }, "its env isn't a map of names to values"],
      [{ command: 'node', enabledTools: [1, 2] }, "its enabledTools isn't a list of names"],
      [{ command: 'node', enabledTools: 'one' }, "its enabledTools isn't a list of names"],
      [{ command: 'node', reconnect: 'yes' }, 'its reconnect is neither true nor false'],
    ] as const) {
      expect(overlayEntryProblem(entry, { strict: true })).toBe(problem);
      expect(overlayEntryProblem(entry)).toBeNull();
      expect(overlayEntryReplaces(entry)).toBe(true);
    }
    // What the boot skips, as main stopped on it or loaded nothing for it.
    for (const [entry, problem] of [
      [{ command: 'node', args: [{}] }, "its args aren't a list of text, numbers or true/false"],
      [{ command: 'node', disabled: 1 }, 'its disabled is neither true nor false'],
    ] as const) {
      expect(overlayEntryProblem(entry)).toBe(problem);
      expect(overlayEntryReplaces(entry)).toBe(false);
    }
  });

  test('an entry naming nothing is skipped, and one the framework fails to open passes on, as on main', () => {
    expect(overlayEntryProblem({ toolPrefix: 'y' })).toBe('it names no command to run and no url to dial');
    // The framework logs the failed connect, and main loaded these the same way.
    expect(overlayEntryProblem({ transport: 'websocket', command: 'node' })).toBeNull();
    expect(overlayEntryProblem({ transport: 'stdio', url: 'wss://w/mcpl' })).toBeNull();
  });

  test('disabled: true is a tombstone whatever else the entry holds: the agent\'s unload wins', () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      writeFileSync(path, JSON.stringify({ mcplServers: { shell: { disabled: true, args: 'x', env: 'y', command: 5 } } }));
      expect(overlayEntryTombstones({ disabled: true, args: 'x' })).toBe(true);
      expect(applyAgentOverlay([shell], path)).toEqual([]);
      expect(overlayWarnings([shell], path)).toEqual([]);
    });
  });

  // The reconnect default keys on a url's presence, as main keyed it, so an
  // entry the framework spawns that also names a url gets it too, and the
  // framework spawns its child again when it exits.
  test('an entry that names a url gets the reconnect default, as on main, and is read by the connection opened', () => {
    const both = { command: 'node', url: 'wss://w/mcpl', env: { SESSION_SERVER_TOKEN: 't' } };
    expect(resolveOverlayEntry('shell', both, '/x/mcpl-servers.agent.json')!.reconnect).toBe(true);
    expect(resolveOverlayEntry('shell', { command: 'node' }, '/x/mcpl-servers.agent.json')!.reconnect).toBeUndefined();
    // Read as spawned: env counts, a token doesn't.
    expect(lostByReplacement(serverProvisions({ ...shell, token: 'tok' }), both)).toBe('env SESSION_SERVER_PORT');
  });

  test('a grant that differs only by spaces is another audience as dialled, either way round', () => {
    const operator = serverProvisions({ id: 'world', url: 'wss://w/mcpl', access: ' eidoverse ' });
    expect(lostByReplacement(operator, { url: 'wss://w/mcpl', access: 'eidoverse' })).toBe('access grant " eidoverse "');
    expect(lostByReplacement(serverProvisions({ id: 'world', url: 'wss://w/mcpl', access: 'eidoverse' }), { url: 'wss://w/mcpl', access: ' eidoverse ' }))
      .toBe('access grant "eidoverse"');
  });

  test("an entry naming nothing to run or dial is malformed too, and said so, not skipped silently", () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      writeFileSync(path, JSON.stringify({ mcplServers: { shell: { toolPrefix: 'y' } } }));
      expect(overlayEntryProblem({ toolPrefix: 'y' })).toBe('it names no command to run and no url to dial');
      expect(applyAgentOverlay([shell], path)).toEqual([shell]);
      expect(overlayWarnings([shell], path)).toEqual([
        `[mcpl] server "shell": the agent overlay (${path}) entry is malformed (it names no command to run and no url to dial), so the boot skips it and the operator's definition loads`,
      ]);
    });
  });

  test("a file that isn't JSON, or whose root is null, stops the boot with an error naming it, never quoting it, as on main", () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      for (const [text, says] of [
        ['{"mcplServers": {"shell": {"env": {"TOKEN": "s3cret"}},}}', "isn't valid JSON"],
        ['null', "isn't an object with mcplServers"],
      ] as const) {
        writeFileSync(path, text);
        expect(() => readAgentOverlay(path)).toThrow(`the agent overlay ${path} ${says}`);
        expect(() => applyAgentOverlay([shell], path)).toThrow(says);
        expect(() => overlayWarnings([shell], path)).toThrow(says);
        try { readAgentOverlay(path); } catch (error) {
          expect(String(error)).not.toContain('s3cret');
          // The advice is to fix it: moving it aside would load what the agent unloaded.
          expect(String(error)).toContain('moving it aside would load every server the agent unloaded');
        }
      }
      // mcplServers: null holds no tombstones, and main read it as empty.
      writeFileSync(path, '{"mcplServers": null}');
      expect(readAgentOverlay(path)).toEqual({});
      expect(applyAgentOverlay([shell], path)).toEqual([shell]);
    });
  });

  // Main read `parsed.mcplServers ?? {}`, so these files started the host,
  // and they still do, each with a line saying how it was read.
  test('a root or an mcplServers of another kind reads as main read it, and is named', () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      const said = (what: string) => `[mcpl] the agent overlay (${path}) ${what}`;
      const noRoot = said('has a root that isn\'t an object, so it holds no entries, as main read it');
      const noMap = said('has an mcplServers that isn\'t a map of entries, so nothing in it loads, as on main');
      for (const [text, line] of [
        ['[]', noRoot],
        ['[{"command": "node"}]', noRoot],
        ['"text"', noRoot],
        ['5', noRoot],
        ['{"mcplServers": "shell"}', noMap],
        ['{"mcplServers": 5}', noMap],
        ['{"mcplServers": false}', noMap],
      ] as const) {
        writeFileSync(path, text);
        expect(readAgentOverlay(path)).toEqual({});
        expect(applyAgentOverlay([shell], path)).toEqual([shell]);
        expect(overlayWarnings([shell], path)).toEqual([line]);
      }
      // A list holds its items as entries named by position, as main iterated it.
      writeFileSync(path, '{"mcplServers": [{"command": "node", "args": ["a.js"]}, {"disabled": true}]}');
      expect(readAgentOverlay(path)).toEqual({ 0: { command: 'node', args: ['a.js'] }, 1: { disabled: true } });
      expect(applyAgentOverlay([{ id: '1', command: 'operator-mcpl' }], path)).toEqual([
        expect.objectContaining({ id: '0', command: 'node' }),
      ]);
      expect(overlayWarnings([], path)).toEqual([
        said('has an mcplServers that\'s a list, so its items are entries named by position ("0", "1", …), as main read them'),
      ]);
    });
  });

  // A misspelled root key, such as Claude Code's `mcpServers`, holds entries
  // and tombstones the boot never reads, whether or not mcplServers holds
  // any.
  test('keys besides mcplServers are named, whether or not mcplServers holds entries', () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      const line = `[mcpl] the agent overlay (${path}) has keys besides mcplServers, "mcpServers", which the boot ignores: ` +
        'an entry or tombstone under a misspelled key doesn\'t load';
      for (const servers of [undefined, {}, { mytool: { command: 'bun' } }]) {
        writeFileSync(path, JSON.stringify({ ...(servers ? { mcplServers: servers } : {}), mcpServers: { shell: { disabled: true } } }));
        expect(applyAgentOverlay([shell], path)[0]).toEqual(shell);
        expect(overlayWarnings([shell], path)).toEqual([line]);
      }
    });
  });

  // In place, as main wrote it: a file renamed over the overlay would take a
  // default mode, replace a symlink with a plain file, and fail on a
  // single-file bind mount.
  test('the overlay is written in place, keeping its mode and a symlink to it', () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      saveAgentOverlay(path, { shell: { disabled: true } });
      chmodSync(path, 0o600);
      saveAgentOverlay(path, { shell: { command: 'node' } });
      expect(readAgentOverlay(path)).toEqual({ shell: { command: 'node' } });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual(['mcpl-servers.agent.json']);
      // Through a symlink: the target changes, and the link stays a link.
      const link = join(dir, 'linked.json');
      symlinkSync(path, link);
      saveAgentOverlay(link, { shell: { disabled: true } });
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readAgentOverlay(path)).toEqual({ shell: { disabled: true } });
    });
  });

  test("a host variable in an env name the host sets itself isn't named: the server never gets that text", () => {
    expect(hostVariableReferences({ command: 'node', env: { AGENT_TIMEZONE: '${TZ}', OTHER: '${OTHER}' } })).toEqual(['env OTHER']);
  });

  test('one tombstone rule for every reader: disabled === true', () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      writeFileSync(path, JSON.stringify({ mcplServers: { gone: { disabled: true } } }));
      expect(applyAgentOverlay([{ id: 'gone', command: 'operator-mcpl' }], path)).toEqual([]);
      expect(overlayEntryTombstones({ disabled: true })).toBe(true);
      expect(overlayEntryTombstones({ disabled: false, command: 'node' })).toBe(false);
      expect(overlayEntryProblem({ disabled: 1 })).toBe('its disabled is neither true nor false');
    });
  });

  test("an access grant naming a host variable is named, as a token's is", () => {
    expect(hostVariableReferences({ url: 'wss://w/mcpl', access: '${GRANT}' })).toEqual(['access']);
  });

  test('only an entry that puts a server in place replaces one', () => {
    expect(overlayEntryReplaces(undefined)).toBe(false);
    expect(overlayEntryReplaces({ disabled: true })).toBe(false);
    expect(overlayEntryReplaces({ env: { A: '1' } })).toBe(false);
    expect(overlayEntryReplaces({ command: 'node' })).toBe(true);
    expect(overlayEntryReplaces({ url: 'wss://x' })).toBe(true);
  });

  test("an operator-only field an entry sets is left out and named at startup, with where the operator grants it", () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      writeFileSync(path, JSON.stringify({ mcplServers: {
        hostCommands: { command: 'node', allowHostCommands: true },
        env: { command: 'node', inheritEnv: true },
        caps: { command: 'node', enabledCapabilities: ['channels'] },
        lifecycle: { command: 'node', toolLifecycle: { observe: {} } },
        // Set to something, though the framework would take no grant from it.
        oddText: { command: 'node', allowHostCommands: 'false' },
        // A mask that lets nothing through, which leaving out widens.
        emptyMask: { command: 'node', enabledCapabilities: [] },
        setsNothing: { command: 'node', allowHostCommands: false, inheritEnv: false },
        setsNothingEither: { command: 'node', allowHostCommands: null, inheritEnv: 0, enabledCapabilities: '', toolLifecycle: null },
      } }));
      const loaded = applyAgentOverlay([], path) as Array<Record<string, unknown>>;
      expect(loaded.map((s) => s.id)).toEqual(['hostCommands', 'env', 'caps', 'lifecycle', 'oddText', 'emptyMask', 'setsNothing', 'setsNothingEither']);
      for (const server of loaded) {
        expect(['allowHostCommands', 'inheritEnv', 'enabledCapabilities', 'toolLifecycle'].filter((k) => k in server)).toEqual([]);
      }
      const named = (id: string, k: string, home: string) =>
        `[mcpl] server "${id}": the agent overlay (${path}) entry loads, but its ${k} is left out, since only the operator's config grants that: set it in ${home}` +
        (k === 'enabledCapabilities' ? '; to narrow what the server may advertise, list what to deny in its disabledCapabilities' : '');
      const fileOrRecipe = 'mcpl-servers.json for a server the recipe names, or the recipe';
      const recipeOwn = "a server the recipe defines itself, with its own command or url and an id mcpl-servers.json doesn't define";
      expect(overlayWarnings([], path)).toEqual([
        named('hostCommands', 'allowHostCommands', recipeOwn), named('env', 'inheritEnv', fileOrRecipe),
        named('caps', 'enabledCapabilities', recipeOwn), named('lifecycle', 'toolLifecycle', fileOrRecipe),
        named('oddText', 'allowHostCommands', recipeOwn), named('emptyMask', 'enabledCapabilities', recipeOwn),
      ]);
    });
  });

  test("an entry that replaces the operator's server says at startup that it lacks the operator's grant", () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      writeFileSync(path, JSON.stringify({ mcplServers: { hc: { command: 'other', allowHostCommands: true } } }));
      const operator = [{ id: 'hc', command: 'node', allowHostCommands: true }];
      expect(overlayWarnings(operator, path)).toEqual([
        `[mcpl] server "hc": the agent overlay (${path}) entry loads, but its allowHostCommands is left out, since only the operator's config grants that: set it in a server the recipe defines itself, with its own command or url and an id mcpl-servers.json doesn't define`,
        `[mcpl] server "hc": the agent overlay (${path}) replaces the operator's definition and lacks its host commands (allowHostCommands), so the server runs without the operator's values for them`,
      ]);
      const loaded = applyAgentOverlay(operator, path) as Array<Record<string, unknown>>;
      expect(loaded).toEqual([expect.objectContaining({ id: 'hc', command: 'other' })]);
      expect('allowHostCommands' in loaded[0]!).toBe(false);
    });
  });

  test("each operator-only field's named home passes it to the boot's servers, and only that home", () => {
    const grant: Record<string, unknown> = {
      inheritEnv: true, toolLifecycle: { observe: {} }, enabledCapabilities: ['contextHooks'], allowHostCommands: true,
    };
    const routes: Record<string, Record<string, boolean>> = {};
    for (const k of OPERATOR_ONLY_OVERLAY_FIELDS) {
      withTmp((dir) => {
        // Whether the boot's one server carries the field as set, from the
        // recipe's servers and mcpl-servers.json as index.ts merges them.
        const reaches = (recipe: Record<string, Record<string, unknown>>, file?: Record<string, unknown>) => {
          const filePath = join(dir, `mcpl-servers-${k}.json`);
          writeFileSync(filePath, JSON.stringify({ mcplServers: file ? { s: file } : {} }));
          const servers = applyAgentOverlay(mergeRecipeServers(recipe, loadMcplServers(filePath)), join(dir, 'none.json')) as Array<Record<string, unknown>>;
          return servers.length === 1 && JSON.stringify(servers[0]![k]) === JSON.stringify(grant[k]);
        };
        routes[k] = {
          // The file, for a server the recipe names, and for one it doesn't.
          fileNamed: reaches({ s: {} }, { command: 'node', [k]: grant[k] }),
          fileUnnamed: reaches({}, { command: 'node', [k]: grant[k] }),
          // The recipe's override of a server from the file.
          override: reaches({ s: { [k]: grant[k] } }, { command: 'node' }),
          // A server the recipe defines itself, with its own command or url,
          // under an id the file doesn't define, and under one it does.
          ownNewId: reaches({ s: { command: 'node', [k]: grant[k] } }),
          ownNewIdUrl: reaches({ s: { url: 'wss://s.example/mcpl', [k]: grant[k] } }),
          ownFileId: reaches({ s: { command: 'other', [k]: grant[k] } }, { command: 'node' }),
        };
        const overlay = join(dir, `agent-${k}.json`);
        writeFileSync(overlay, JSON.stringify({ mcplServers: { e: { command: 'node', [k]: grant[k] } } }));
        const [line] = overlayWarnings([], overlay);
        // enabledCapabilities' note also names the narrowing an overlay keeps.
        const narrow = k === 'enabledCapabilities' ? '; to narrow what the server may advertise, list what to deny in its disabledCapabilities' : '';
        expect({ k, line }).toEqual({ k, line: expect.stringMatching(routes[k]!.fileNamed
          ? /: set it in mcpl-servers\.json for a server the recipe names, or the recipe$/
          : new RegExp(`: set it in a server the recipe defines itself, with its own command or url and an id mcpl-servers\\.json doesn't define${narrow}$`)) });
      });
    }
    // As the code stands: inheritEnv and toolLifecycle reach the boot from the
    // file for a server the recipe names, from an override, and from the
    // recipe's own server; the other two only from the recipe's own server
    // under an id the file doesn't define. No file server the recipe leaves
    // unnamed loads at all.
    const passOn = { fileNamed: true, fileUnnamed: false, override: true, ownNewId: true, ownNewIdUrl: true, ownFileId: true };
    const recipeOwnOnly = { fileNamed: false, fileUnnamed: false, override: false, ownNewId: true, ownNewIdUrl: true, ownFileId: false };
    expect(routes).toEqual({
      enabledCapabilities: recipeOwnOnly, toolLifecycle: passOn, inheritEnv: passOn, allowHostCommands: recipeOwnOnly,
    });
  });

  test("a reconnect that isn't true or false reads by its truth, as main read it, except the text \"false\", each named; null is off, unnamed", () => {
    withTmp((dir) => {
      const path = join(dir, 'mcpl-servers.agent.json');
      writeFileSync(path, JSON.stringify({ mcplServers: {
        // agent-framework 0.22.3 refuses all but true, false and null, so the
        // framework is handed true or false. Each entry keeps the retrying it
        // had on main, except "false", which main's truth turned on. The note
        // says what to write.
        text: { url: 'wss://a/mcpl', reconnect: 'true' },
        textFalse: { url: 'wss://g/mcpl', reconnect: 'false' },
        capitalFalse: { url: 'wss://h/mcpl', reconnect: ' False ' },
        one: { url: 'wss://b/mcpl', reconnect: 1 },
        empty: { url: 'wss://c/mcpl', reconnect: '' },
        zero: { url: 'wss://d/mcpl', reconnect: 0 },
        command: { command: 'node', reconnect: 'yes' },
        off: { url: 'wss://e/mcpl', reconnect: null },
        on: { url: 'wss://f/mcpl', reconnect: true },
      } }));
      const loaded = applyAgentOverlay([], path) as Array<Record<string, unknown>>;
      // Every entry loads, and each is handed a boolean.
      expect(loaded.map((s) => s.id)).toEqual(['text', 'textFalse', 'capitalFalse', 'one', 'empty', 'zero', 'command', 'off', 'on']);
      expect(Object.fromEntries(loaded.map((s) => [s.id, s.reconnect]))).toStrictEqual({
        text: true, textFalse: false, capitalFalse: false, one: true, empty: false, zero: false, command: true, off: false, on: true,
      });
      const note = (id: string, read: boolean) =>
        `[mcpl] server "${id}": the agent overlay (${path}) entry loads, but its reconnect isn't true or false, so it's read as ${read}: write true or false, without quotes`;
      expect(overlayWarnings([], path)).toEqual([
        note('text', true), note('textFalse', false), note('capitalFalse', false), note('one', true), note('empty', false), note('zero', false), note('command', true),
      ]);
    });
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

  // The receipt says naming a host variable in an overlay entry wouldn't fill
  // it in, and the likeliest next move is to write one anyway: `${VAR}` there
  // reaches the child as literal text, so it supplies nothing.
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
