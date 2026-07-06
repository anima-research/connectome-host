/**
 * McplAdminModule — agent-facing deploy/restart/unload tools, exercised
 * against a stub framework. Overlay persistence is verified on disk.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentFramework } from '@animalabs/agent-framework';

import { McplAdminModule } from '../src/modules/mcpl-admin-module.js';
import { readAgentOverlay, saveAgentOverlay } from '../src/mcpl-config.js';

interface StubServer {
  id: string;
  connected: boolean;
  toolPrefix: string;
  toolCount: number;
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
        toolPrefix: config.toolPrefix ?? `mcpl--${config.id}`,
        toolCount: 1,
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
        toolPrefix: `mcpl--${id}`,
        toolCount: 1,
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
    expect(text).toContain('source=agent-overlay');
    expect(text).toContain('gone: UNLOADED');
  });
});
