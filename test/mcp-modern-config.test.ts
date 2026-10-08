/**
 * Modern MCP (2026-07-28) servers across the host's configuration surfaces:
 * recipe mcpServers, mcpl-servers.json, the agent overlay and mcpl_deploy.
 * The protocol rules are agent-framework's own (resolveServerBinding,
 * serverConfigProblems); these tests pin that every surface applies them,
 * and that existing stdio and WebSocket entries are unchanged.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentFramework } from '@animalabs/agent-framework';

import { validateRecipe } from '../src/recipe.js';
import { createBranchState, handleCommand } from '../src/commands.js';
import {
  AGENT_DEPLOY_DENIED_CAPABILITIES,
  DEFAULT_CONFIG_PATH,
  applyAgentOverlay,
  isModernServer,
  loadMcplServers,
  mergeRecipeServers,
  readAgentOverlay,
  readMcplServersFile,
  registryEntryView,
  resolveOverlayEntry,
  saveAgentOverlay,
  saveMcplServers,
  serverProblems,
  type ServerFileEntry,
} from '../src/mcpl-config.js';
import { McplAdminModule } from '../src/modules/mcpl-admin-module.js';
import { buildMcplSnapshot } from '../src/web/panel-data.js';

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

  test('a recipe deadline override survives the merge and is checked there', () => {
    const file = [{ id: 'srv', command: 'node' }];
    const kept = mergeRecipeServers({ srv: { protocol: 'modern', requestTimeoutMs: 120000 } }, file);
    expect(kept[0]).toMatchObject({ protocol: 'modern', requestTimeoutMs: 120000 });
    expect(serverProblems(kept[0]!)).toEqual([]);
    const zero = mergeRecipeServers({ srv: { protocol: 'modern', requestTimeoutMs: 0 } }, file);
    expect(zero[0]).toMatchObject({ requestTimeoutMs: 0 });
    expect(serverProblems(zero[0]!).join('; ')).toMatch(/requestTimeoutMs/);
  });

  test("a recipe's http(s) url makes a file-defined server modern HTTP; a ws url keeps its old meaning", () => {
    const file = [{ id: 'srv', command: 'old-server', args: ['--x'], protocol: 'legacy', env: { A: '1' } }];
    const http = mergeRecipeServers({ srv: { url: 'https://tools.example/mcp', token: 't' } }, file)[0]!;
    expect(http).toMatchObject({ id: 'srv', url: 'https://tools.example/mcp', token: 't' });
    expect(http.command).toBeUndefined();
    expect(http.args).toBeUndefined();
    expect(http.protocol).toBeUndefined();
    expect(isModernServer(http)).toBe(true);
    expect(serverProblems(http)).toEqual([]);
    // A ws url without a transport leaves the file's command in charge, as before.
    const ws = mergeRecipeServers({ srv: { url: 'wss://host/mcpl' } }, file)[0]!;
    expect(ws).toMatchObject({ command: 'old-server', url: 'wss://host/mcpl' });
    expect(isModernServer(ws)).toBe(false);
  });

  test("a recipe's own command and args don't keep the file's launch under its http(s) url", () => {
    // A recipe may carry a full fallback block for an id the file defines
    // (recipes/SETUP.md's gitlab); its command never applies to that id.
    const merged = mergeRecipeServers(
      { srv: { command: 'recipe-fallback', args: ['--r'], url: 'https://tools.example/mcp' } },
      [{ id: 'srv', command: 'old-server', args: ['--x'] }],
    )[0]!;
    expect(merged).toMatchObject({ id: 'srv', url: 'https://tools.example/mcp' });
    expect(merged.command).toBeUndefined();
    expect(merged.args).toBeUndefined();
    expect(isModernServer(merged)).toBe(true);
    expect(serverProblems(merged)).toEqual([]);
  });

  test("a file's own transport doesn't outlive a recipe's http(s) url; a recipe transport is kept and checked", () => {
    const fromStdio = mergeRecipeServers(
      { srv: { url: 'https://tools.example/mcp' } },
      [{ id: 'srv', command: 'node', transport: 'stdio' }],
    )[0]!;
    expect(fromStdio.transport).toBeUndefined();
    expect(fromStdio.command).toBeUndefined();
    expect(serverProblems(fromStdio)).toEqual([]);
    expect(isModernServer(fromStdio)).toBe(true);

    const fromWs = mergeRecipeServers(
      { srv: { url: 'https://tools.example/mcp' } },
      [{ id: 'srv', url: 'wss://host/mcpl', transport: 'websocket', token: 't' }],
    )[0]!;
    expect(fromWs).toMatchObject({ url: 'https://tools.example/mcp', token: 't' });
    expect(fromWs.transport).toBeUndefined();
    expect(serverProblems(fromWs)).toEqual([]);
    expect(isModernServer(fromWs)).toBe(true);

    const explicit = mergeRecipeServers(
      { srv: { url: 'https://tools.example/mcp', transport: 'websocket' } },
      [{ id: 'srv', command: 'node' }],
    )[0]!;
    expect(explicit.transport).toBe('websocket');
    expect(serverProblems(explicit).length).toBeGreaterThan(0);
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

  test("MCPL-only policy on a modern entry is refused, including fields the loader doesn't carry", () => {
    const notCarried: Record<string, unknown> = {
      enabledCapabilities: ['channels'],
      disabledCapabilities: ['contextHooks'],
      scopes: { chat: {} },
      allowHostCommands: true,
      autofetch: { maxBytes: 1024 },
      shouldTriggerInference: true,
    };
    for (const [field, value] of Object.entries(notCarried)) {
      for (const target of [{ url: 'https://tools.example/mcp' }, { command: 'node', protocol: 'modern' }]) {
        expect(() => loadMcplServers(writeFile({ bad: { ...target, [field]: value } })))
          .toThrow(new RegExp(`mcpl-servers\\.json: mcplServers\\.bad: .*"${field}" is MCPL policy`));
      }
    }
  });

  test('empty or false MCPL-only values on a modern entry, and those fields on a legacy entry, still load', () => {
    const loaded = loadMcplServers(writeFile({
      quiet: { url: 'https://tools.example/mcp', allowHostCommands: false, disabledCapabilities: [], scopes: {}, autofetch: {} },
      legacy: { command: 'node', args: ['./srv.js'], allowHostCommands: true, disabledCapabilities: ['x'] },
    }));
    expect(loaded.map((s) => s.id)).toEqual(['quiet', 'legacy']);
    // Checking the entry as written doesn't change what loads: relative args
    // still resolve, and the loader carries these fields for neither family.
    expect(loaded[1]).toMatchObject({ command: 'node', args: [join(dir, 'srv.js')] });
    expect(loaded[1]).not.toHaveProperty('allowHostCommands');
    expect(loaded[0]).not.toHaveProperty('allowHostCommands');
  });
});

describe('registry views: /mcp list, /mcp add and the panel registry', () => {
  // The /mcp commands and the panel read DEFAULT_CONFIG_PATH (cwd's
  // gitignored mcpl-servers.json); restore whatever was there.
  const original = existsSync(DEFAULT_CONFIG_PATH) ? readFileSync(DEFAULT_CONFIG_PATH, 'utf-8') : null;
  afterEach(() => {
    if (original !== null) writeFileSync(DEFAULT_CONFIG_PATH, original);
    else if (existsSync(DEFAULT_CONFIG_PATH)) unlinkSync(DEFAULT_CONFIG_PATH);
  });
  const app = () =>
    ({ framework: { getAllAgents: () => [], getAllModules: () => [] }, branchState: createBranchState() }) as never;
  const listLines = () => handleCommand('/mcp list', app()).lines.map((l) => l.text);

  test('the target is the one the binding selects, not whichever field is present', () => {
    expect(registryEntryView('a', { command: 'node', args: ['srv.js'], url: 'https://tools.example/mcp' }))
      .toEqual({ target: 'node srv.js', family: 'legacy', transport: 'stdio' });
    expect(registryEntryView('b', { command: 'node', url: 'https://tools.example/mcp', transport: 'http' }))
      .toEqual({ target: 'https://tools.example/mcp', family: 'modern', transport: 'http' });
    expect(registryEntryView('c', { command: 'node', url: 'wss://host/mcpl', transport: 'websocket' }))
      .toEqual({ target: 'wss://host/mcpl', family: 'legacy', transport: 'websocket' });
    expect(registryEntryView('d', { command: 'node', protocol: 'modern' }))
      .toEqual({ target: 'node', family: 'modern', transport: 'stdio' });
  });

  test('a refused entry still shows what it holds, with the reasons', () => {
    const unresolvable = registryEntryView('x', { command: 'node', transport: 'websocket' });
    expect(unresolvable.target).toBe('node');
    expect(unresolvable.family).toBeUndefined();
    expect(unresolvable.transport).toBeUndefined();
    expect(unresolvable.problems!.join('; ')).toMatch(/transport "websocket" requires "url"/);
    const policy = registryEntryView('y', { url: 'https://tools.example/mcp', allowHostCommands: true } as ServerFileEntry);
    expect(policy).toMatchObject({ target: 'https://tools.example/mcp', family: 'modern', transport: 'http' });
    expect(policy.problems!.join('; ')).toMatch(/"allowHostCommands" is MCPL policy/);
  });

  test('/mcp list and the panel registry show that target, and why an entry is refused', () => {
    saveMcplServers(DEFAULT_CONFIG_PATH, {
      mixed: { command: 'node', args: ['srv.js'], url: 'https://tools.example/mcp' },
      moved: { command: 'node', url: 'https://tools.example/mcp', transport: 'http' },
      broken: { command: 'node', transport: 'websocket' },
    });
    const lines = listLines();
    expect(lines).toContain('  mixed: node srv.js (legacy/stdio)');
    expect(lines).toContain('  moved: https://tools.example/mcp (modern/http)');
    const broken = lines.indexOf('  broken: node');
    expect(broken).toBeGreaterThan(0);
    expect(lines[broken + 1]).toMatch(/^ {4}refused at startup: .*transport "websocket" requires "url"/);

    const snap = buildMcplSnapshot({ framework: {} } as never) as { servers: Array<Record<string, unknown>> };
    expect(snap.servers).toEqual([
      { id: 'mixed', target: 'node srv.js', family: 'legacy', transport: 'stdio' },
      { id: 'moved', target: 'https://tools.example/mcp', family: 'modern', transport: 'http' },
      { id: 'broken', target: 'node', problems: [expect.stringMatching(/transport "websocket" requires "url"/)] },
    ]);
  });

  test('/mcp add replaces a network target with the command it names, keeping the other settings', () => {
    saveMcplServers(DEFAULT_CONFIG_PATH, {
      web: { url: 'https://tools.example/mcp', transport: 'http', token: 't', env: { A: '1' }, toolPrefix: 'w' },
      sock: { url: 'wss://host/mcpl', transport: 'websocket', access: 'eidoverse', reconnect: true },
    });
    const replaced = handleCommand('/mcp add web node srv.js', app()).lines.map((l) => l.text).join('\n');
    handleCommand('/mcp add sock node', app());
    const saved = readMcplServersFile(DEFAULT_CONFIG_PATH);
    expect(saved.web).toEqual({ command: 'node', args: ['srv.js'], token: 't', env: { A: '1' }, toolPrefix: 'w' });
    expect(saved.sock).toEqual({ command: 'node', access: 'eidoverse', reconnect: true });
    expect(replaced).toContain('(replaced url: https://tools.example/mcp)');
    expect(replaced).toContain('(kept env: A)');
    const lines = listLines();
    expect(lines).toContain('  web: node srv.js (legacy/stdio)');
    expect(lines).toContain('  sock: node (legacy/stdio)');
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

  function makeFramework(state: { connected: boolean; retrying?: boolean } = { connected: true }) {
    const connected: Connected[] = [];
    const framework = {
      listMcplServers: () => connected.map((c) => ({
        id: c.id,
        connected: state.connected,
        retrying: state.retrying ?? false,
        toolCount: 2,
        toolPrefix: `mcpl--${c.id}`,
        ...(c.url ? { url: c.url } : {}),
        ...(c.command ? { command: c.command } : {}),
        family: c.url?.startsWith('http') || c.protocol === 'modern' ? 'modern' as const : 'legacy' as const,
        protocolVersion: state.connected ? (c.url?.startsWith('http') || c.protocol === 'modern' ? '2026-07-28' : '2024-11-05') : null,
        transport: c.transport ?? (c.url?.startsWith('http') ? 'http' : c.url ? 'websocket' : 'stdio'),
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

  test('status names the target its transport uses, not an unused command', async () => {
    const { framework, connected } = makeFramework();
    connected.push({ id: 'moved', command: 'old-server', url: 'https://tools.example/mcp', transport: 'http' });
    const mod = makeModule(framework);
    const text = String((await call(mod, 'mcpl_list', {})).data ?? '');
    expect(text).toMatch(/moved: CONNECTED — protocol=modern@2026-07-28\/http; .*https:\/\/tools\.example\/mcp/);
    expect(text).not.toMatch(/old-server/);
    const snap = buildMcplSnapshot({ framework } as never) as { live: Array<{ id: string; target?: string; family?: string; transport?: string }> };
    expect(snap.live[0]).toMatchObject({ id: 'moved', target: 'https://tools.example/mcp', family: 'modern', transport: 'http' });
  });

  test('protocol: "" is the schema-valid unspecified value; anything unknown is refused', async () => {
    const { framework } = makeFramework();
    const mod = makeModule(framework);
    const deploy = mod.getTools().concat(mod.getUtilities()).find((t) => t.name === 'mcpl_deploy')!;
    expect((deploy.inputSchema as { properties: { protocol: { enum: string[] } } }).properties.protocol.enum).toEqual(['', 'legacy', 'modern']);
    expect((await call(mod, 'mcpl_deploy', { id: 'h', url: 'https://tools.example/mcp', protocol: '' })).success).toBe(true);
    const refused = await call(mod, 'mcpl_deploy', { id: 'f', command: 'node', protocol: 'future' });
    expect(refused.success).toBe(false);
    expect(String(refused.error ?? refused.data)).toMatch(/protocol must be "legacy", "modern" or ""/);
    expect(readAgentOverlay(join(dir, 'mcpl-servers.agent.json')).f).toBeUndefined();
  });

  test("deploy reports the framework's actual disposition and protocol", async () => {
    const { framework } = makeFramework({ connected: false, retrying: true });
    const mod = makeModule(framework);
    const result = await call(mod, 'mcpl_deploy', { id: 'slow', url: 'https://tools.example/mcp' });
    expect(result.success).toBe(true);
    const text = String(result.data ?? '');
    expect(text).toMatch(/"slow": NOT connected yet; reconnecting in the background, protocol=modern@unestablished\/http/);
    expect(text).not.toMatch(/: connected,/);
    const live = makeFramework();
    const ok = await call(makeModule(live.framework), 'mcpl_deploy', { id: 'fast', url: 'https://tools.example/mcp' });
    expect(String(ok.data ?? '')).toMatch(/"fast": connected, protocol=modern@2026-07-28\/http, 2 tools/);
  });
});
