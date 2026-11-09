import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, type Module } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';

import { deprecatedSurfaceNotices, validateRecipe } from '../src/recipe.js';
import { McplAdminModule } from '../src/modules/mcpl-admin-module.js';
import { ObserversModule } from '../src/modules/observers-module.js';
import { SubagentModule } from '../src/modules/subagent-module.js';
import { buildMcplSnapshot } from '../src/web/panel-data.js';

const schema = { type: 'object', properties: {} };

function probeModule(): Module {
  return {
    name: 'probe',
    async start() {},
    async stop() {},
    getTools: () => [{ name: 'plain', description: 'plain', inputSchema: schema }],
    getUtilities: () => [{ name: 'util', description: 'util', inputSchema: schema }],
    async handleToolCall() { return { success: true }; },
    async onProcess() { return {}; },
  } as unknown as Module;
}

const PLACED = [
  'mcpl-admin--mcpl_list', 'mcpl-admin--mcpl_deploy', 'mcpl-admin--mcpl_restart', 'mcpl-admin--mcpl_unload',
  'observers--get', 'observers--grant', 'observers--revoke',
];
const RESTRICTED = ['mcpl-admin--mcpl_list', 'observers--get', 'probe--plain', 'probe--util', 'agent_settings'];
const OPEN_ONLY = [...RESTRICTED, 'toolsets--open'];

let dir: string;
let framework: AgentFramework;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'host-toolsets-'));
  framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new Membrane(new MockAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() }),
    agents: [
      { name: 'resident', model: 'mock', systemPrompt: 'resident', maxTokens: 256 },
      { name: 'restricted', model: 'mock', systemPrompt: 'restricted', maxTokens: 256, allowedTools: RESTRICTED },
      { name: 'open-only', model: 'mock', systemPrompt: 'open-only', maxTokens: 256, allowedTools: OPEN_ONLY },
    ],
    modules: [
      new McplAdminModule({ overlayPath: join(dir, 'overlay.json'), configPath: join(dir, 'servers.json') }),
      new ObserversModule({ path: join(dir, 'observers.json') }),
      probeModule(),
    ],
  });
});

afterAll(async () => {
  await framework.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const toolList = (agentName: string): string[] => {
  const agent = framework.getAgent(agentName)!;
  const tools = framework.getAllTools().filter((t) => agent.canUseTool(t.name));
  return framework.presentedTools(agentName, tools).map((t) => t.name);
};

describe('where the host\'s tools are under agent-framework\'s host toolsets', () => {
  test('an agent with the toolsets-- tools has mcpl-admin\'s and observers\' tools and module utilities out of its tool list, and a module\'s other tools in it', () => {
    const names = toolList('resident');
    const all = framework.getAllTools().map((t) => t.name);
    for (const name of [...PLACED, 'probe--util']) {
      expect(all).toContain(name);
      expect(names).not.toContain(name);
    }
    expect(names).toContain('probe--plain');
    expect(names).toContain('toolsets--open');
    expect(names).toContain('toolsets--act');
  });

  test('an agent whose allowedTools doesn\'t give it the toolsets-- tools keeps the placed tools it may call in its tool list, and no utility', () => {
    const names = toolList('restricted');
    expect(names).toEqual(expect.arrayContaining(['mcpl-admin--mcpl_list', 'observers--get', 'probe--plain', 'agent_settings']));
    expect(names).not.toContain('probe--util');
    expect(names.some((n) => n.startsWith('toolsets--'))).toBe(false);
  });

  test('an agent permitted toolsets--open but not toolsets--act sees toolsets--open in its tool list and keeps the placed tools it may call there too', () => {
    const names = toolList('open-only');
    expect(names).toEqual(expect.arrayContaining(['toolsets--open', 'mcpl-admin--mcpl_list', 'observers--get', 'agent_settings']));
    expect(names).not.toContain('toolsets--act');
    expect(names).not.toContain('probe--util');
  });
});

describe('the retired surface keys', () => {
  const recipe = (modules: Record<string, unknown>) => ({ name: 'surface-test', agent: { systemPrompt: 'sys' }, modules });

  test('a recipe setting modules.mcplAdmin.surface or modules.webui.observersSurface still loads, and startup names each as no longer read', () => {
    const loaded = validateRecipe(recipe({
      mcplAdmin: { surface: 'utilities' },
      webui: { observersSurface: 'utilities', basicAuth: { username: 'u', password: 'p' } },
    }));
    const notices = deprecatedSurfaceNotices(loaded.modules);
    expect(notices).toHaveLength(2);
    expect(notices.some((line) => line.startsWith('modules.mcplAdmin.surface is no longer read'))).toBe(true);
    expect(notices.some((line) => line.startsWith('modules.webui.observersSurface is no longer read'))).toBe(true);
  });

  test('a recipe without them gets no such line', () => {
    expect(deprecatedSurfaceNotices(validateRecipe(recipe({ mcplAdmin: true })).modules)).toEqual([]);
    expect(deprecatedSurfaceNotices(undefined)).toEqual([]);
  });
});

describe('a spawn\'s prompt-size check (issue #511)', () => {
  async function launchBeside(placement: 'builtin' | 'utility' | undefined, opts: { tools?: string[]; kind?: 'spawn' | 'fork' } = {}) {
    const tmp = mkdtempSync(join(tmpdir(), 'host-toolsets-size-'));
    const bulky = {
      name: 'bulky',
      async start() {},
      async stop() {},
      getTools: () => (placement === 'utility' ? [] : [{ name: 'big', description: 'x'.repeat(400_000), inputSchema: schema }]),
      getUtilities: () => (placement === 'utility' ? [{ name: 'big', description: 'x'.repeat(400_000), inputSchema: schema }] : []),
      toolPlacement: () => (placement === 'builtin' ? 'builtin' : undefined),
      async handleToolCall() { return { success: true }; },
      async onProcess() { return {}; },
    } as unknown as Module;
    const subagent = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock', defaultMaxTokens: 256, maxPromptTokens: 60_000 });
    const fw = await AgentFramework.create({
      storePath: join(tmp, 'store'),
      membrane: new Membrane(new MockAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() }),
      agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent', maxTokens: 256 }],
      modules: [subagent as unknown as Module, bulky],
    });
    subagent.setFramework(fw);
    fw.start();
    try {
      return await subagent.handleToolCall({
        id: 't-size', name: opts.kind ?? 'spawn', callerAgentName: 'parent',
        input: opts.kind === 'fork'
          ? { name: 'scout', task: 't', sync: true }
          : { name: 'scout', systemPrompt: 'sp', task: 't', sync: true, ...(opts.tools ? { tools: opts.tools } : {}) },
      });
    } finally {
      await fw.stop().catch(() => {});
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  test('a tool in the built-in settings toolset, which the spawn\'s first request leaves out, isn\'t counted, and the spawn runs', async () => {
    expect(await launchBeside('builtin')).toMatchObject({ success: true });
  });

  test('a module utility, which no first request carries, isn\'t counted, and the spawn runs', async () => {
    expect(await launchBeside('utility')).toMatchObject({ success: true });
  });

  test('the same tool in its tool list is counted', async () => {
    expect((await launchBeside(undefined)).error).toContain('over this host\'s limit of 60000');
  });

  test('a tool placed in the settings toolset is counted for a spawn whose tools leave out toolsets--open and toolsets--act, since it stays in that spawn\'s tool list', async () => {
    expect((await launchBeside('builtin', { tools: ['bulky--big'] })).error).toContain('over this host\'s limit of 60000');
  });

  test('a fork counts the same way: a tool in the settings toolset isn\'t counted, and one in its tool list is', async () => {
    expect(await launchBeside('builtin', { kind: 'fork' })).toMatchObject({ success: true });
    expect((await launchBeside(undefined, { kind: 'fork' })).error).toContain('over this host\'s limit of 60000');
  });
});

describe('the Web UI\'s MCPL panel', () => {
  test('says a server agent-framework holds as a closed tab is one, apart from a disconnected one', () => {
    const fw = {
      listMcplServers: () => [
        { id: 'games', connected: false, closedTab: true, toolCount: 0 },
        { id: 'broken', connected: false, toolCount: 0 },
      ],
    };
    const snap = buildMcplSnapshot({ framework: fw as never, recipe: {} as never }) as {
      live: Array<{ id: string; connected: boolean; closedTab?: boolean }>;
    };
    expect(snap.live.find((s) => s.id === 'games')).toMatchObject({ connected: false, closedTab: true });
    expect(snap.live.find((s) => s.id === 'broken')!.closedTab).toBeUndefined();
  });
});
