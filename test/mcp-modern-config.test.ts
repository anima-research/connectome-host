/**
 * Modern MCP (2026-07-28) servers across the host's configuration surfaces:
 * recipe mcpServers, mcpl-servers.json, the agent overlay and mcpl_deploy.
 * The protocol rules are agent-framework's own (resolveServerBinding,
 * serverConfigProblems); these tests pin that every surface applies them,
 * and that existing stdio and WebSocket entries are unchanged.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentFramework } from '@animalabs/agent-framework';

import { validateRecipe } from '../src/recipe.js';
import {
  AGENT_DEPLOY_DENIED_CAPABILITIES,
  applyAgentOverlay,
  isModernServer,
  loadMcplServers,
  mergeRecipeServers,
  readAgentOverlay,
  resolveOverlayEntry,
  saveAgentOverlay,
  serverProblems,
} from '../src/mcpl-config.js';
import { McplAdminModule } from '../src/modules/mcpl-admin-module.js';

const BASELINE = [...AGENT_DEPLOY_DENIED_CAPABILITIES].sort();

function recipeWith(server: Record<string, unknown>) {
  return { name: 'modern-test', agent: { systemPrompt: 'sys' }, mcpServers: { srv: server } };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-modern-config-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('recipe mcpServers', () => {
  test('an http(s) url is a modern server; protocol: modern marks a modern stdio server', () => {
    expect(() => validateRecipe(recipeWith({ url: 'https://tools.example/mcp', token: 't' }))).not.toThrow();
    expect(() => validateRecipe(recipeWith({ url: 'http://127.0.0.1:8080/mcp', transport: 'http' }))).not.toThrow();
    expect(() => validateRecipe(recipeWith({ command: 'node', args: ['srv.js'], protocol: 'modern' }))).not.toThrow();
    expect(() => validateRecipe(recipeWith({ command: 'node', protocol: 'modern', requestTimeoutMs: 120000, enabledTools: ['read_*'] }))).not.toThrow();
  });

  test('existing stdio and WebSocket entries are unchanged', () => {
    expect(() => validateRecipe(recipeWith({ command: 'node', args: ['srv.js'], enabledFeatureSets: ['chat'] }))).not.toThrow();
    expect(() => validateRecipe(recipeWith({ url: 'wss://host/mcpl', transport: 'websocket', token: 't' }))).not.toThrow();
    expect(() => validateRecipe(recipeWith({ command: 'node', requestTimeoutMs: 0 }))).not.toThrow();
    expect(() => validateRecipe(recipeWith({ command: 'node', protocol: 'legacy', channelSubscription: 'auto' }))).not.toThrow();
  });

  test('protocol on a URL server is refused', () => {
    expect(() => validateRecipe(recipeWith({ url: 'https://tools.example/mcp', protocol: 'modern' })))
      .toThrow(/mcpServers\.srv: .*protocol/);
    expect(() => validateRecipe(recipeWith({ url: 'wss://host/mcpl', protocol: 'legacy' })))
      .toThrow(/mcpServers\.srv: .*protocol/);
  });

  test('a modern deadline must be an integer from 1 to 2^31-1', () => {
    for (const requestTimeoutMs of [0, 1.5, 2 ** 31]) {
      expect(() => validateRecipe(recipeWith({ url: 'https://tools.example/mcp', requestTimeoutMs })))
        .toThrow(/mcpServers\.srv: .*requestTimeoutMs/);
    }
  });

  test('MCPL-only policy on a modern server is refused', () => {
    expect(() => validateRecipe(recipeWith({ url: 'https://tools.example/mcp', enabledFeatureSets: ['chat'] })))
      .toThrow(/mcpServers\.srv: .*enabledFeatureSets/);
    expect(() => validateRecipe(recipeWith({ command: 'node', protocol: 'modern', channelSubscription: 'auto' })))
      .toThrow(/mcpServers\.srv: .*channelSubscription/);
  });

  test('a transport that disagrees with the url, or an unknown protocol, is refused', () => {
    expect(() => validateRecipe(recipeWith({ url: 'https://tools.example/mcp', transport: 'websocket' })))
      .toThrow(/mcpServers\.srv: /);
    expect(() => validateRecipe(recipeWith({ url: 'wss://host/mcpl', transport: 'http' })))
      .toThrow(/mcpServers\.srv: /);
    expect(() => validateRecipe(recipeWith({ command: 'node', protocol: 'newest' })))
      .toThrow(/protocol must be "legacy" or "modern"/);
  });

  test('a recipe may set protocol on a file-defined server, and the merged server is checked', () => {
    const merged = mergeRecipeServers(
      { srv: { protocol: 'modern', enabledTools: ['read_*'] } },
      [{ id: 'srv', command: 'node', args: ['srv.js'] }],
    );
    expect(merged[0]).toMatchObject({ id: 'srv', command: 'node', protocol: 'modern', enabledTools: ['read_*'] });
    expect(serverProblems(merged[0]!)).toEqual([]);
    expect(isModernServer(merged[0]!)).toBe(true);

    const misapplied = mergeRecipeServers(
      { srv: { protocol: 'modern' } },
      [{ id: 'srv', command: 'node', enabledFeatureSets: ['chat'] }],
    );
    expect(serverProblems(misapplied[0]!).join('; ')).toMatch(/enabledFeatureSets/);
  });
});

describe('mcpl-servers.json', () => {
  function writeFile(servers: Record<string, unknown>): string {
    const path = join(dir, 'mcpl-servers.json');
    writeFileSync(path, JSON.stringify({ mcplServers: servers }));
    return path;
  }

  test('url, token, access and protocol entries load as written', () => {
    const loaded = loadMcplServers(writeFile({
      tools: { url: 'https://tools.example/mcp', token: 't', requestTimeoutMs: 90000 },
      grant: { url: 'https://grant.example/mcp', access: 'eidoverse' },
      local: { command: 'node', args: ['./srv.js'], protocol: 'modern' },
      chat: { command: 'node', args: ['chat.js'], enabledFeatureSets: ['chat'] },
      ws: { url: 'wss://host/mcpl', transport: 'websocket' },
    }));
    const byId = Object.fromEntries(loaded.map((s) => [s.id, s]));
    expect(byId.tools).toMatchObject({ url: 'https://tools.example/mcp', token: 't', requestTimeoutMs: 90000 });
    expect(byId.grant).toMatchObject({ url: 'https://grant.example/mcp', access: 'eidoverse' });
    expect(byId.local).toMatchObject({ command: 'node', args: [join(dir, 'srv.js')], protocol: 'modern' });
    expect(byId.chat).toMatchObject({ command: 'node', enabledFeatureSets: ['chat'] });
    expect(byId.chat!.protocol).toBeUndefined();
    expect(byId.ws).toMatchObject({ url: 'wss://host/mcpl', transport: 'websocket' });
  });

  test('an entry the framework would refuse fails the load, naming the file and id', () => {
    expect(() => loadMcplServers(writeFile({ bad: { url: 'https://tools.example/mcp', protocol: 'modern' } })))
      .toThrow(/mcpl-servers\.json: mcplServers\.bad: .*protocol/);
    expect(() => loadMcplServers(writeFile({ bad: { command: 'node', protocol: 'modern', disabledFeatureSets: ['x'] } })))
      .toThrow(/mcpl-servers\.json: mcplServers\.bad: .*disabledFeatureSets/);
  });
});

describe('agent overlay', () => {
  test('a modern entry carries no MCPL capability mask; a legacy one keeps it', () => {
    expect(resolveOverlayEntry('h', { url: 'https://tools.example/mcp' }, join(dir, 'o.json')))
      .toEqual({ id: 'h', url: 'https://tools.example/mcp', reconnect: true });
    expect(resolveOverlayEntry('s', { command: 'node', protocol: 'modern' }, join(dir, 'o.json')))
      .toEqual({ id: 's', command: 'node', protocol: 'modern' });
    expect(resolveOverlayEntry('l', { command: 'node' }, join(dir, 'o.json')))
      .toEqual({ id: 'l', command: 'node', disabledCapabilities: BASELINE });
  });

  test('an unusable overlay entry is skipped, not fatal; the rest still load', () => {
    const overlayPath = join(dir, 'mcpl-servers.agent.json');
    saveAgentOverlay(overlayPath, {
      bad: { url: 'https://tools.example/mcp', enabledFeatureSets: ['chat'] },
      good: { url: 'https://tools.example/mcp' },
    });
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      const servers = applyAgentOverlay([{ id: 'recipe-one', command: 'node' }], overlayPath);
      expect(servers.map((s) => s.id)).toEqual(['recipe-one', 'good']);
    } finally {
      console.error = original;
    }
    expect(errors.join('\n')).toMatch(/overlay server "bad" skipped: .*enabledFeatureSets/);
  });
});

describe('mcpl_deploy and mcpl_list', () => {
  interface Connected { id: string; url?: string; command?: string; transport?: string; protocol?: string; disabledCapabilities?: string[] }

  function makeFramework() {
    const connected: Connected[] = [];
    const framework = {
      listMcplServers: () => connected.map((c) => ({
        id: c.id,
        connected: true,
        toolCount: 2,
        toolPrefix: `mcpl--${c.id}`,
        ...(c.url ? { url: c.url } : { command: c.command }),
        family: c.url?.startsWith('http') || c.protocol === 'modern' ? 'modern' as const : 'legacy' as const,
        protocolVersion: c.url?.startsWith('http') || c.protocol === 'modern' ? '2026-07-28' : '2024-11-05',
        transport: c.url?.startsWith('http') ? 'http' : c.url ? 'websocket' : 'stdio',
      })),
      connectMcplServer: async (config: Connected) => { connected.push(config); },
      restartMcplServer: async () => {},
      disconnectMcplServer: async () => {},
    };
    return { framework: framework as unknown as AgentFramework, connected };
  }

  function makeModule(framework: AgentFramework) {
    const mod = new McplAdminModule({ overlayPath: join(dir, 'mcpl-servers.agent.json'), configPath: join(dir, 'mcpl-servers.json') });
    mod.setFramework(framework);
    return mod;
  }

  const call = (mod: McplAdminModule, name: string, input: Record<string, unknown>) =>
    mod.handleToolCall({ id: 'c1', name, input } as never);

  test('an https url deploys a modern server: no transport written, no MCPL mask', async () => {
    const { framework, connected } = makeFramework();
    const mod = makeModule(framework);
    const result = await call(mod, 'mcpl_deploy', { id: 'tools', url: 'https://tools.example/mcp', protocol: '', enabledFeatureSets: [] });
    expect(result.success).toBe(true);
    expect(readAgentOverlay(join(dir, 'mcpl-servers.agent.json')).tools).toEqual({ url: 'https://tools.example/mcp' });
    expect(connected[0]).toMatchObject({ id: 'tools', url: 'https://tools.example/mcp', reconnect: true });
    expect(connected[0]!.transport).toBeUndefined();
    expect(connected[0]!.disabledCapabilities).toBeUndefined();
  });

  test('protocol: modern deploys a modern stdio server; a ws url keeps its websocket entry', async () => {
    const { framework, connected } = makeFramework();
    const mod = makeModule(framework);
    expect((await call(mod, 'mcpl_deploy', { id: 'local', command: 'node', protocol: 'modern' })).success).toBe(true);
    expect((await call(mod, 'mcpl_deploy', { id: 'ws', url: 'wss://host/mcpl' })).success).toBe(true);
    const overlay = readAgentOverlay(join(dir, 'mcpl-servers.agent.json'));
    expect(overlay.local).toEqual({ command: 'node', protocol: 'modern' });
    expect(overlay.ws).toEqual({ url: 'wss://host/mcpl', transport: 'websocket' });
    expect(connected[1]).toMatchObject({ disabledCapabilities: BASELINE });
  });

  test('a configuration the framework would refuse is refused before anything is saved', async () => {
    const { framework, connected } = makeFramework();
    const mod = makeModule(framework);
    const overlayPath = join(dir, 'mcpl-servers.agent.json');
    for (const input of [
      { id: 'a', url: 'https://tools.example/mcp', protocol: 'modern' },
      { id: 'b', url: 'https://tools.example/mcp', enabledFeatureSets: ['chat'] },
      { id: 'c', url: 'ftp://tools.example/mcp' },
    ]) {
      const result = await call(mod, 'mcpl_deploy', input);
      expect(result.success).toBe(false);
      expect(String(result.error ?? result.data)).toMatch(/mcpl_deploy refused ".": .*Nothing was saved/);
    }
    expect(existsSync(overlayPath)).toBe(false);
    expect(connected).toEqual([]);
  });

  test('mcpl_list shows each server\'s family, revision and transport', async () => {
    const { framework } = makeFramework();
    const mod = makeModule(framework);
    await call(mod, 'mcpl_deploy', { id: 'tools', url: 'https://tools.example/mcp' });
    await call(mod, 'mcpl_deploy', { id: 'chat', command: 'node' });
    const result = await call(mod, 'mcpl_list', {});
    const text = String(result.data ?? '');
    expect(text).toMatch(/tools: CONNECTED — protocol=modern@2026-07-28\/http; 2 tools/);
    expect(text).not.toMatch(/tools: .*policy=/);
    expect(text).toMatch(/chat: CONNECTED — protocol=legacy@2024-11-05\/stdio, policy=/);
  });
});
