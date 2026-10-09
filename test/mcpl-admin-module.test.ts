/**
 * McplAdminModule — agent-facing deploy/restart/unload tools, exercised
 * against a stub framework. Overlay persistence is verified on disk.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentFramework } from '@animalabs/agent-framework';

import { McplAdminModule } from '../src/modules/mcpl-admin-module.js';
import { readAgentOverlay, saveAgentOverlay } from '../src/mcpl-config.js';

interface StubServer {
  id: string;
  connected: boolean;
  retrying: boolean;
  toolPrefix: string;
  toolCount: number;
  policyEstablished: boolean;
  effectiveGrant: string[];
  maskedCapabilities: string[];
  deniedCapabilities: string[];
  allowHostCommands: boolean;
  manifestState?: {
    lastValidatedRevision: string | null;
    lastFetchedAt: number | null;
    lastNegotiatedAt: number | null;
  };
  toolClasses?: Array<{ tool: string; serverTool: string; class: string[]; source: string }>;
  command?: string;
  url?: string;
}

function makeStubFramework() {
  const servers = new Map<string, StubServer>();
  const calls: string[] = [];
  const stub = {
    listMcplServers: () => [...servers.values()],
    connectMcplServer: async (config: { id: string; command?: string; url?: string; toolPrefix?: string }) => {
      calls.push(`connect:${config.id}`);
      if (servers.has(config.id)) throw new Error(`MCPL server "${config.id}" is already registered`);
      servers.set(config.id, {
        id: config.id,
        connected: true,
        retrying: false,
        toolPrefix: config.toolPrefix ?? `mcpl--${config.id}`,
        toolCount: 1,
        policyEstablished: true,
        effectiveGrant: ['channels.incoming'],
        maskedCapabilities: ['channels.streaming'],
        deniedCapabilities: ['contextHooks.beforeInference.inject.system'],
        allowHostCommands: false,
        manifestState: {
          lastValidatedRevision: 'sha256:validated',
          lastFetchedAt: Date.parse('2026-08-05T01:02:03.000Z'),
          lastNegotiatedAt: Date.parse('2026-08-05T01:02:04.000Z'),
        },
        command: config.command,
        url: config.url,
      });
    },
    disconnectMcplServer: async (id: string) => {
      calls.push(`disconnect:${id}`);
      servers.delete(id);
    },
    restartMcplServer: async (id: string, config?: { id: string; command?: string }) => {
      calls.push(`restart:${id}`);
      if (!servers.has(id) && !config) throw new Error(`MCPL server "${id}" is not configured`);
      const prev = servers.get(id);
      servers.set(id, {
        id,
        connected: true,
        retrying: false,
        toolPrefix: `mcpl--${id}`,
        toolCount: 1,
        policyEstablished: true,
        effectiveGrant: ['channels.incoming'],
        maskedCapabilities: ['channels.streaming'],
        deniedCapabilities: ['contextHooks.beforeInference.inject.system'],
        allowHostCommands: false,
        manifestState: {
          lastValidatedRevision: 'sha256:validated',
          lastFetchedAt: Date.parse('2026-08-05T01:02:03.000Z'),
          lastNegotiatedAt: Date.parse('2026-08-05T01:02:04.000Z'),
        },
        command: config?.command ?? prev?.command,
      });
    },
  };
  return { stub: stub as unknown as AgentFramework, servers, calls };
}

let dir: string;
let overlayPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpl-admin-'));
  overlayPath = join(dir, 'mcpl-servers.agent.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeModule(framework: AgentFramework) {
  const mod = new McplAdminModule({
    overlayPath,
    configPath: join(dir, 'mcpl-servers.json'),
  });
  mod.setFramework(framework);
  return mod;
}

function call(mod: McplAdminModule, name: string, input: Record<string, unknown> = {}) {
  return mod.handleToolCall({ id: 'c1', name, input } as never);
}

describe('mcpl_deploy', () => {
  test('deploys a new server: connects it and persists to the overlay', async () => {
    const { stub, servers, calls } = makeStubFramework();
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node', args: ['tool.js'] });

    expect(result.success).toBe(true);
    expect(calls).toEqual(['connect:mytool']);
    expect(servers.has('mytool')).toBe(true);
    expect(readAgentOverlay(overlayPath).mytool).toEqual({ command: 'node', args: ['tool.js'] });
  });

  test('redeploying a loaded server restarts it with the new config', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);

    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });
    const result = await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'bun' });

    expect(result.success).toBe(true);
    expect(calls).toEqual(['connect:mytool', 'restart:mytool']);
    expect(readAgentOverlay(overlayPath).mytool).toEqual({ command: 'bun' });
  });

  test('rejects missing command/url, both at once, and bad ids', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);

    expect((await call(mod, 'mcpl_deploy', { id: 'x' })).success).toBe(false);
    expect((await call(mod, 'mcpl_deploy', { id: 'x', command: 'a', url: 'ws://b' })).success).toBe(false);
    expect((await call(mod, 'mcpl_deploy', { id: 'bad id!', command: 'a' })).success).toBe(false);
  });

  test('connect failure keeps the overlay entry and reports the error', async () => {
    const { stub } = makeStubFramework();
    (stub as unknown as { connectMcplServer: () => Promise<void> }).connectMcplServer =
      async () => { throw new Error('spawn ENOENT'); };
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_deploy', { id: 'broken', command: 'nonexistent' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('spawn ENOENT');
    expect(readAgentOverlay(overlayPath).broken).toEqual({ command: 'nonexistent' });
  });
});

describe('mcpl_unload', () => {
  test('agent-deployed server: disconnects and deletes the overlay entry', async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });

    const result = await call(mod, 'mcpl_unload', { id: 'mytool' });

    expect(result.success).toBe(true);
    expect(servers.has('mytool')).toBe(false);
    expect(readAgentOverlay(overlayPath).mytool).toBeUndefined();
  });

  test('recipe server: disconnects and writes a tombstone', async () => {
    const { stub, servers } = makeStubFramework();
    // Simulate a recipe-loaded server the module didn't deploy.
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_unload', { id: 'discord' });

    expect(result.success).toBe(true);
    expect(servers.has('discord')).toBe(false);
    expect(readAgentOverlay(overlayPath).discord).toEqual({ disabled: true });
  });

  test('persist:false leaves the overlay untouched', async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_unload', { id: 'discord', persist: false });

    expect(result.success).toBe(true);
    expect(servers.has('discord')).toBe(false);
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  test('unknown server errors', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    expect((await call(mod, 'mcpl_unload', { id: 'nope' })).success).toBe(false);
  });
});

describe('mcpl_restart', () => {
  test('restarts a loaded server', async () => {
    const { stub, calls } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_restart', { id: 'discord' });

    expect(result.success).toBe(true);
    expect(calls).toEqual(['connect:discord', 'restart:discord']);
  });
});

describe('mcpl_list', () => {
  test('shows live servers, sources, and tombstones', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'bun' });
    saveAgentOverlay(overlayPath, { ...readAgentOverlay(overlayPath), gone: { disabled: true } });

    const result = await call(mod, 'mcpl_list');

    expect(result.success).toBe(true);
    const text = String(result.data);
    expect(text).toContain('discord: CONNECTED');
    expect(text).toContain('mytool: CONNECTED');
    expect(text).toContain('policy=established');
    expect(text).toContain('grant=[channels.incoming]');
    expect(text).toContain('masked=[channels.streaming]');
    expect(text).toContain('denied=[contextHooks.beforeInference.inject.system]');
    expect(text).toContain('hostCommands=deny');
    expect(text).toContain(
      'manifest={revision="sha256:validated",' +
      'fetchedAt=2026-08-05T01:02:03.000Z,' +
      'negotiatedAt=2026-08-05T01:02:04.000Z}',
    );
    expect(text).toContain('source=agent-overlay');
    expect(text).toContain('gone: UNLOADED');
  });

  test('distinguishes older-framework unknown and bounds untrusted revisions', async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);

    const server = servers.get('discord')!;
    delete server.manifestState;
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('manifest=unknown');

    server.manifestState = {
      lastValidatedRevision: `unsafe\n${'x'.repeat(100)}`,
      lastFetchedAt: null,
      lastNegotiatedAt: null,
    };
    const text = String((await call(mod, 'mcpl_list')).data);
    expect(text).toContain('manifest={revision="unsafe\\n');
    expect(text).not.toContain('unsafe\n');
    expect(text).toContain('...",fetchedAt=none,negotiatedAt=none}');
  });

  test("groups each server's tools by effective class and source", async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'chat', command: 'node' });
    const mod = makeModule(stub);

    // Older framework: no per-server classes reported.
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('classes=unknown');

    servers.get('chat')!.toolClasses = [
      { tool: 'chat--say', serverTool: 'say', class: ['comms'], source: 'server' },
      { tool: 'chat--send', serverTool: 'send', class: ['comms'], source: 'server' },
      { tool: 'chat--upload', serverTool: 'upload', class: ['files', 'comms'], source: 'override' },
      { tool: 'chat--probe', serverTool: 'probe', class: [], source: 'none' },
    ];
    expect(String((await call(mod, 'mcpl_list')).data)).toContain(
      'classes={comms/server: say,send; files+comms/override: upload; unclassed: probe}',
    );

    servers.get('chat')!.toolClasses = [];
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('classes={}');
  });
});

// Since agent-framework scrubs a stdio child's environment, an overlay entry
// that replaces the operator's definition runs without whatever of it the
// entry lacks: a resident's shell came back from mcpl_restart without
// SESSION_SERVER_TOKEN (2026-10-08), the restart reported success, and the
// first call said only "Connection lost". The receipts now say what the host
// knows, by name only.
describe('an overlay entry that replaces the operator definition', () => {
  const operatorShell = {
    id: 'shell',
    command: 'node',
    args: ['/abs/terminal-sessions/mcp-stdio-server.js'],
    env: { SESSION_SERVER_TOKEN: 's3cret-token', SESSION_SERVER_PORT: '3101' },
  };

  /** A host as it boots with the resident's 09-04-style entry: the overlay's
   *  shell is what loaded, in place of the operator's. */
  async function bootWithReplacement(entry: Record<string, unknown> = { command: 'node', args: ['mine.js'], env: { SESSION_SERVER_PORT: '3101' } }) {
    const fw = makeStubFramework();
    saveAgentOverlay(overlayPath, { shell: entry });
    await (fw.stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'shell', command: 'node' });
    const mod = makeModule(fw.stub);
    mod.setOperatorServers([operatorShell, { id: 'discord', command: 'node', env: { DISCORD_TOKEN: 'real' } }]);
    return { ...fw, mod };
  }

  test('mcpl_restart names what it lacks, never a value, and the way back', async () => {
    const { mod } = await bootWithReplacement();

    const result = await call(mod, 'mcpl_restart', { id: 'shell' });

    expect(result.success).toBe(true);
    const text = String(result.data);
    expect(text).toContain('Restarted server "shell" — connected');
    expect(text).toContain(
      'replaces the operator\'s definition of "shell" and lacks its env SESSION_SERVER_TOKEN, ' +
      'so the server runs without the operator\'s values for them. An overlay entry can\'t name host variables.',
    );
    expect(text).not.toContain('SESSION_SERVER_PORT');
    expect(text).not.toContain('s3cret-token');
    expect(text).toContain('mcpl_unload "shell"');
    expect(text).toContain('the operator\'s loads again at the next host start');
  });

  test('mcpl_restart says nothing more when the entry lacks nothing, or replaces nothing', async () => {
    const { mod } = await bootWithReplacement({
      command: 'node',
      env: { SESSION_SERVER_PORT: '3101', SESSION_SERVER_TOKEN: 'its-own' },
    });
    expect(String((await call(mod, 'mcpl_restart', { id: 'shell' })).data)).toBe('Restarted server "shell" — connected, 1 tools.');

    // No operator definitions wired (an older embedding): no claim either way.
    const bare = makeStubFramework();
    await (bare.stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'shell', command: 'node' });
    expect(String((await call(makeModule(bare.stub), 'mcpl_restart', { id: 'shell' })).data))
      .toBe('Restarted server "shell" — connected, 1 tools.');
  });

  test('mcpl_deploy over an operator id says it replaces the definition, and what it lacks', async () => {
    const { mod } = await bootWithReplacement({ command: 'node' });

    const lacking = await call(mod, 'mcpl_deploy', { id: 'shell', command: 'node', args: ['rebuilt.js'] });
    expect(lacking.success).toBe(true);
    expect(String(lacking.data)).toContain(
      'replaces the operator\'s definition of "shell" and lacks its env SESSION_SERVER_PORT, SESSION_SERVER_TOKEN',
    );

    const carrying = await call(mod, 'mcpl_deploy', { id: 'discord', command: 'node', env: { DISCORD_TOKEN: 'mine' } });
    expect(carrying.success).toBe(true);
    expect(String(carrying.data)).toEndWith(' Your overlay entry replaces the operator\'s definition of "discord".');

    const fresh = await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'bun' });
    expect(String(fresh.data)).not.toContain('operator');
  });

  // The likeliest next move after reading that receipt: name the variable in
  // the entry. Only a recipe substitutes it, so the receipt keeps the name
  // in what's lacking and says why, without showing the value.
  test('an entry that names a host variable still lacks it, and is told so', async () => {
    const { mod } = await bootWithReplacement();

    const result = await call(mod, 'mcpl_deploy', {
      id: 'shell',
      command: 'node',
      args: ['mine.js'],
      env: { SESSION_SERVER_PORT: '3101', SESSION_SERVER_TOKEN: '${SESSION_SERVER_TOKEN}' },
    });

    const text = String(result.data);
    expect(text).toContain('lacks its env SESSION_SERVER_TOKEN, so the server runs without the operator\'s values for them.');
    expect(text).toContain(
      'Your entry names a host variable in env SESSION_SERVER_TOKEN, and only a recipe substitutes those, ' +
      'so the server gets that text as written.',
    );
    expect(text).not.toContain('${SESSION_SERVER_TOKEN}');
    expect(String((await call(mod, 'mcpl_restart', { id: 'shell' })).data))
      .toContain('Your entry names a host variable in env SESSION_SERVER_TOKEN');
  });

  test('a host-variable reference in an entry that replaces nothing is told on deploy and restart', async () => {
    const { mod } = await bootWithReplacement();

    const deployed = String((await call(mod, 'mcpl_deploy', {
      id: 'weather', command: 'node', args: ['--key', '${WEATHER_KEY}'], env: { WEATHER_UNITS: 'metric' },
    })).data);
    expect(deployed).toEndWith(
      'Your entry names a host variable in args, and only a recipe substitutes those, so the server gets that text as written.',
    );
    expect(deployed).not.toContain('operator');
    expect(String((await call(mod, 'mcpl_restart', { id: 'weather' })).data))
      .toContain('Your entry names a host variable in args');
  });

  // Greptile's review of #227: a restart that throws keeps the note, and an
  // overlay file that can't be read costs only the note, never the restart's
  // own outcome or a quote of the file.
  test('a restart that throws still says what the entry lacks', async () => {
    const { stub, mod } = await bootWithReplacement();
    (stub as unknown as { restartMcplServer: () => Promise<void> }).restartMcplServer =
      async () => { throw new Error('spawn ENOENT'); };

    const result = await call(mod, 'mcpl_restart', { id: 'shell' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('mcpl_restart failed: spawn ENOENT.');
    expect(result.error).toContain('lacks its env SESSION_SERVER_TOKEN');
  });

  test('an overlay file that can\'t be read leaves the restart\'s own outcome', async () => {
    const { mod } = await bootWithReplacement();
    writeFileSync(overlayPath, '{"mcplServers": {"shell": {"env": {"SECRET": "s3cret-in-file"');

    const result = await call(mod, 'mcpl_restart', { id: 'shell' });

    expect(result.success).toBe(true);
    expect(String(result.data)).toBe(
      'Restarted server "shell" — connected, 1 tools. Your overlay file couldn\'t be read, so nothing is said here about your entry.',
    );
    expect(String(result.data)).not.toContain('s3cret');
  });

  test('mcpl_list marks the replacement and what it lacks', async () => {
    const { mod } = await bootWithReplacement();

    const text = String((await call(mod, 'mcpl_list')).data);

    expect(text).toContain('source=agent-overlay (replaces the operator\'s definition; lacks its env SESSION_SERVER_TOKEN)');
    expect(text).not.toContain('s3cret-token');
  });

  test('mcpl_list credits the overlay only with an entry that put a server in place', async () => {
    // Neither command nor url: the boot skips this entry, so the live
    // server is the operator's (applyAgentOverlay / resolveOverlayEntry).
    const { mod } = await bootWithReplacement({ env: { SESSION_SERVER_TOKEN: 'x' } });

    const text = String((await call(mod, 'mcpl_list')).data);

    expect(text).toContain('source=recipe');
    expect(text).not.toContain('source=agent-overlay');
  });

  test('mcpl_unload of a replacement says the operator definition loads again at the next start', async () => {
    const { mod } = await bootWithReplacement();

    const result = await call(mod, 'mcpl_unload', { id: 'shell' });

    expect(result.success).toBe(true);
    expect(String(result.data)).toContain('the operator\'s definition of "shell" loads again at the next host start');
    expect(readAgentOverlay(overlayPath).shell).toBeUndefined();
  });
});

describe('restart and deploy report the connection they read', () => {
  test('mcpl_restart fails when the server is not connected afterwards', async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; url: string }) => Promise<void> })
      .connectMcplServer({ id: 'world', url: 'wss://w/mcpl' });
    const restart = (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer;
    (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer = async (id) => {
      await restart(id);
      Object.assign(servers.get(id)!, { connected: false, retrying: true });
    };
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_restart', { id: 'world' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Restarted server "world", but it isn\'t connected (it keeps retrying).');
  });

  test('mcpl_deploy fails, keeping the entry, when the connect resolves without a connection', async () => {
    const { stub, servers } = makeStubFramework();
    const connect = (stub as unknown as { connectMcplServer: (c: { id: string }) => Promise<void> }).connectMcplServer;
    (stub as unknown as { connectMcplServer: (c: { id: string }) => Promise<void> }).connectMcplServer = async (config) => {
      await connect(config);
      Object.assign(servers.get(config.id)!, { connected: false, retrying: true });
    };
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_deploy', { id: 'world', url: 'wss://down/mcpl' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Server "world" was saved to your overlay but isn\'t connected (it keeps retrying).');
    expect(readAgentOverlay(overlayPath).world).toEqual({ url: 'wss://down/mcpl', transport: 'websocket' });
  });
});
