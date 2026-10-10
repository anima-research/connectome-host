/**
 * MCPL RFC-008 §6 on the operator surfaces: `/tools` (TUI, readline, web UI
 * and headless share handleCommand) and the `tool-classes` panel op behind
 * `GET /debug/tool-classes`, against a real AgentFramework configured the way
 * index.ts configures it (toolClassConfig), plus stubs for the edges the real
 * framework can't produce here (MCPL rows, a build without the listing).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';

import { handleCommand } from '../src/commands.js';
import { formatToolClassRows, toolClassConfig, type ToolClassRow } from '../src/tool-lifecycle-config.js';
import { buildMcplSnapshot, runPanelOp } from '../src/web/panel-data.js';

/** A module whose tools fall under each class source: `lessons--*` is in
 *  HOST_TOOL_CLASSES (memory), `probe--note` is overridden by the recipe,
 *  `probe--misc` is unclassed. */
function probeModule(name: string, tools: string[]): Module {
  return {
    name,
    async start() {},
    async stop() {},
    getTools: () => tools.map((t) => ({ name: t, description: t, inputSchema: { type: 'object', properties: {} } })),
    async handleToolCall() { return { success: true }; },
    async onProcess() { return {}; },
  } as unknown as Module;
}

function appFor(framework: unknown): Parameters<typeof handleCommand>[1] {
  return {
    framework: framework as AgentFramework,
    sessionManager: {} as never,
    recipe: { name: 'test', agent: { name: 'resident' } } as never,
    branchState: {} as never,
    switchSession: async () => {},
  };
}

const texts = (command: string, framework: unknown): string[] =>
  handleCommand(command, appFor(framework)).lines.map((l) => l.text);

let tmpDir: string;
let framework: AgentFramework;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tool-classes-surface-'));
  framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane: new Membrane(new MockAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() }),
    agents: [{ name: 'resident', model: 'mock', systemPrompt: 'resident', maxTokens: 256 }],
    modules: [
      probeModule('probe', ['note', 'misc']),
      probeModule('lessons', ['recall']),
    ],
    ...(toolClassConfig({ toolClassOverrides: { 'probe--note': ['notes'] } }) as object),
  });
});

afterAll(async () => {
  await framework.stop().catch(() => {});
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('/tools', () => {
  test('lists every tool with its effective class and source', () => {
    const lines = texts('/tools', framework);
    expect(lines[0]).toMatch(/^--- Tool classes: \d+ tools \(all agents\) ---$/);
    expect(lines[1]).toMatch(/1 operator override · \d+ host table · \d+ unclassed/);
    const row = (tool: string): string => {
      const found = lines.find((l) => l.trimStart().startsWith(`${tool} `));
      if (!found) throw new Error(`no row for ${tool} in:\n${lines.join('\n')}`);
      return found.replace(/\s+/g, ' ').trim();
    };
    expect(row('probe--note')).toBe('probe--note notes operator override');
    expect(row('lessons--recall')).toBe('lessons--recall memory host table');
    expect(row('probe--misc')).toBe('probe--misc - unclassed');
    // Sorted by tool name.
    const tools = lines.slice(2).filter((l) => /^ {2}\S+ {2,}/.test(l)).map((l) => l.trim().split(/\s+/)[0]!);
    expect(tools).toEqual([...tools].sort());
    // The unclassed footnote says what unclassed means and how to fix it.
    expect(lines.at(-1)).toContain('toolClassOverrides');
  });

  test('scopes to one agent, and names an unknown agent', () => {
    expect(texts('/tools resident', framework)[0]).toMatch(/\(resident\) ---$/);
    expect(texts('/tools nobody', framework)).toEqual(['Unknown agent: nobody']);
  });

  test('takes the rest of the line as the agent name (names may contain spaces)', () => {
    const asked: Array<string | undefined> = [];
    const rows: ToolClassRow[] = [{ tool: 'time--now', class: ['control'], source: 'host' }];
    const fw = { listToolClasses: (agent?: string) => { asked.push(agent); return rows; } };
    expect(texts('/tools Custom Import', fw)[0]).toBe('--- Tool classes: 1 tool (Custom Import) ---');
    texts('/tools', fw);
    // Surrounding whitespace is not part of the name; whitespace alone is no name.
    texts('/tools resident ', fw);
    texts('/tools   ', fw);
    expect(asked).toEqual(['Custom Import', undefined, 'resident', undefined]);
  });

  test('a framework without the listing says so', () => {
    expect(texts('/tools', {})).toEqual(['This agent-framework build does not report tool classes.']);
  });

  test('MCPL tools name their server; no footnote without unclassed tools', () => {
    const rows: ToolClassRow[] = [
      { tool: 'chat--say', class: ['comms'], source: 'server', serverId: 'chat' },
      { tool: 'blender--render', class: ['media', 'files'], source: 'override', serverId: 'blender' },
    ];
    const lines = texts('/tools', { listToolClasses: () => rows });
    expect(lines).toEqual([
      '--- Tool classes: 2 tools (all agents) ---',
      '  1 operator override · 1 server _meta',
      '  blender--render  media,files  operator override (blender)',
      '  chat--say        comms        server _meta (chat)',
    ]);
  });

  test('is listed in /help', () => {
    expect(texts('/help', {}).some((l) => l.includes('/tools [agent]'))).toBe(true);
  });
});

describe('formatToolClassRows', () => {
  test('caps the tool column so one long name does not push every row', () => {
    const long = `x--${'y'.repeat(80)}`;
    const [, ...table] = formatToolClassRows([
      { tool: long, class: [], source: 'none' },
      { tool: 'a--b', class: ['shell'], source: 'host' },
    ]);
    expect(table[0]).toBe(`${long}  -      unclassed`);
    expect(table[1]).toBe(`a--b${' '.repeat(44)}  shell  host table`);
  });
});

describe('tool-classes panel op (GET /debug/tool-classes)', () => {
  const app = () => ({ framework, recipe: { name: 'test', agent: { name: 'resident' } } as never });

  test('every tool by default, with per-source counts', async () => {
    const res = await runPanelOp(app(), 'tool-classes');
    expect(res.ok).toBe(true);
    const data = (res as { data: { agent: string | null; counts: Record<string, number>; tools: ToolClassRow[] } }).data;
    expect(data.agent).toBeNull();
    expect(data.tools.find((t) => t.tool === 'probe--note')).toEqual({ tool: 'probe--note', class: ['notes'], source: 'override' });
    expect(data.tools.find((t) => t.tool === 'probe--misc')).toEqual({ tool: 'probe--misc', class: [], source: 'none' });
    expect(data.tools.find((t) => t.tool === 'lessons--recall')?.source).toBe('host');
    const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(data.tools.length);
    expect(data.counts.override).toBe(1);
  });

  test('?agent= scopes to that agent; unknown agent is 404, no listing is 501', async () => {
    const scoped = await runPanelOp(app(), 'tool-classes', { agent: 'resident' });
    expect(scoped.ok && (scoped.data as { agent: string }).agent).toBe('resident');

    const unknown = await runPanelOp(app(), 'tool-classes', { agent: 'nobody' });
    expect(unknown).toMatchObject({ ok: false, status: 404 });

    const old = await runPanelOp(
      { framework: { getAgent: () => undefined } as never, recipe: {} as never },
      'tool-classes',
    );
    expect(old).toMatchObject({ ok: false, status: 501 });
  });

  test('the MCPL panel snapshot carries the same rows', async () => {
    const snap = buildMcplSnapshot(app()) as { toolClasses?: ToolClassRow[] };
    const op = await runPanelOp(app(), 'tool-classes');
    expect(snap.toolClasses).toEqual((op as { data: { tools: ToolClassRow[] } }).data.tools);
    // An older framework: the field is omitted rather than empty.
    const bare = buildMcplSnapshot({ framework: {} as never, recipe: {} as never });
    expect('toolClasses' in bare).toBe(false);
  });
});
