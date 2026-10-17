/**
 * `/bug`: a report for connectome-host's public issues that can't carry
 * conversation text. The guarantee is checked by canaries: one in every
 * source of text a session writes and in every field a user can set. None
 * may reach the report, its title, its link, the command's output or the
 * file it saves.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentFramework } from '@animalabs/agent-framework';

import {
  BUG_REPORT_MARKER,
  BUG_REPORT_URL_CAP,
  HOST_LOG_TAGS,
  buildBugReport,
  bugReportUrl,
  currentSession,
  formatBugReport,
  frameLocation,
  gatherBugReportFacts,
  parseErrorLog,
  publicModelId,
  runtimeMode,
  serverRows,
  composedServerConfigs,
  frameScope,
  setupFacts,
  type FrameScope,
  sessionMarker,
  setCallLogPath,
  summarizeProviderCalls,
  tailLines,
  type BugReportFacts,
} from '../src/bug-report.js';
import { FleetModule } from '../src/modules/fleet-module.js';
import { parseCommand } from '../src/command-name.js';
import { createBranchState, handleCommand } from '../src/commands.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-10-11T23:50:00.000Z');
/** Spelled so no casing of the report's own words can contain it. */
const CANARY = 'zqxcanaryzqx';
/** This process's call log, by name, in the canary data directory. */
const CALL_LOG = 'llm-calls.2026-10-11T23-00-00-000Z.jsonl';
/** A scope for made-up frames: the paths are taken as real, the checkout
 *  tracks everything, and agent-framework is installed under ROOT. */
function fakeScope(realpath: (file: string) => string | null = (file) => file): FrameScope {
  return {
    hostRoot: ROOT,
    tracked: null,
    packageRoots: new Map([['agent-framework', join(ROOT, 'node_modules/@animalabs/agent-framework')]]),
    realpath,
  };
}
/** A data directory under the checkout, as DATA_DIR's default puts it. */
const SESSION_FILE_DIR = join(ROOT, `data-bug-probe-${process.pid}`, 'workspace');

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'bug-report-'));
}

/** A data directory holding a canary in every source of text. */
function canaryDataDir(): string {
  const dir = scratch();
  mkdirSync(SESSION_FILE_DIR, { recursive: true });
  writeFileSync(join(SESSION_FILE_DIR, `${CANARY}-scene.js`), '// written by a session\n');
  const call = (fields: Record<string, unknown>) => JSON.stringify({
    kind: 'stream', timestamp: '2026-10-11T23:40:00.000Z', durationMs: 900,
    rawRequest: { system: `system ${CANARY}`, messages: [{ role: 'user', content: `hi ${CANARY}` }] },
    response: { content: [{ type: 'text', text: `reply ${CANARY}` }] },
    ...fields,
  });
  // An older process's call log, newer by name than this one's: never read.
  writeFileSync(join(dir, 'llm-calls.2026-10-12T00-00-00-000Z.jsonl'), call({ type: 'error', httpStatus: 500 }) + '\n');
  writeFileSync(join(dir, CALL_LOG), [
    call({ type: 'call' }),
    // The Anthropic and Bedrock writers put no provider key on a record.
    call({
      type: 'error', httpStatus: 529, errorType: 'server', retryable: true,
      providerErrorCode: 'overloaded_error', error: `Overloaded while answering "${CANARY}"`,
    }),
    call({
      type: 'error', provider: CANARY, httpStatus: 400, errorType: CANARY, retryable: false,
      providerErrorCode: `${CANARY}_code`, error: `echo of the request: ${CANARY}`,
      timestamp: '2026-10-11T23:45:00.000Z',
    }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'tui-error.log'), [
    '--- session 2026-10-11T22:00:00.000Z ---',
    `[mcpl] an earlier session's line ${CANARY}`,
    '--- session 2026-10-11T23:00:00.000Z ---',
    `[mcpl] server "srv" handler failed: ${CANARY}`,
    `[mcpl] another ${CANARY}`,
    `[routing] speech for ${CANARY}`,
    `[${CANARY}] a server's own stderr line`,
    `TypeError: cannot read ${CANARY} of undefined`,
    `    at handleBug (${join(ROOT, 'src/commands.ts')}:12:3)`,
    `    at ${CANARY}Fn (/home/${CANARY}/project/src/thing.ts:1:1)`,
    `    at processTicksAndRejections (node:internal/process/task_queues:105:5)`,
    `Zqxcanaryzqx${'Error'}: a class name the user's code made up`,
    `    at handleBug (${join(ROOT, 'src/commands.ts')}:40:9)`,
    `    at forged (${join(ROOT, `src/${CANARY}.ts`)}:1:1)`,
    // A file a session wrote under the checkout's data directory, with a
    // name from the conversation: it exists, but isn't our code.
    'ReferenceError: x is not defined',
    `    at run (${join(SESSION_FILE_DIR, `${CANARY}-scene.js`)}:3:1)`,
    `a quoted message: "${CANARY}"`,
  ].join('\n') + '\n');
  return dir;
}

/** A recipe with a canary in every field a user can set. */
function canaryRecipe(model = `${CANARY}-finetune`) {
  return {
    name: `${CANARY} recipe`,
    description: `${CANARY} description`,
    agent: {
      name: `${CANARY}-agent`,
      provider: 'openai-compatible',
      model,
      baseUrl: `https://${CANARY}.example/v1`,
      systemPrompt: `You are ${CANARY}.`,
      maxTokens: 8192,
      contextBudgetTokens: 150000,
      cacheTtl: '1h',
      proseRouting: 'locus',
      thinking: { enabled: true },
    },
    modules: { subagents: true, wake: true, lessons: false, [`${CANARY}Module`]: true },
    extensions: { [`${CANARY}Ext`]: { path: `/home/${CANARY}/ext.js` } },
    mcpServers: {
      [`${CANARY}-server`]: { command: `/home/${CANARY}/bin/server`, args: [CANARY], env: { TOKEN: CANARY } },
      // A name under our scope that isn't one of our servers is still a name someone chose.
      scoped: { command: 'node', source: { npm: `@animalabs/${CANARY}@1.0.0` } },
      discord: { command: 'node', args: ['x'], source: { npm: '@animalabs/discord-mcpl@1.2.3' } },
      other: { command: 'npx', args: [`${CANARY}-mcp`], source: { npm: `${CANARY}-mcp@1.0.0` } },
      remote: { url: `wss://${CANARY}.example/mcpl?token=${CANARY}`, token: CANARY },
    },
  };
}

const LIVE = [
  { id: `${CANARY}-server`, connected: true, toolCount: 4 },
  { id: 'discord', connected: false, retrying: true, toolCount: 0 },
  { id: 'other', connected: true, toolCount: 2 },
  { id: 'remote', connected: false, refused: `MCP server "remote": url wss://${CANARY}.example/mcpl does not match transport "stdio"`, toolCount: 0 },
  { id: 'scoped', connected: true, toolCount: 1 },
];

function canaryFacts(dir: string, mode: 'tui' | 'headless' = 'tui', recipe: ReturnType<typeof canaryRecipe> = canaryRecipe()): BugReportFacts {
  return gatherBugReportFacts({
    now: NOW,
    mode,
    dataDir: dir,
    recipe,
    liveServers: LIVE,
    serverConfig: (id) => (recipe.mcpServers as Record<string, never>)[id],
    callLog: join(dir, CALL_LOG),
  });
}

afterAll(() => rmSync(dirname(SESSION_FILE_DIR), { recursive: true, force: true }));

function expectNoCanary(text: string, where: string): void {
  expect(text.toLowerCase().includes(CANARY), `${where} carries the canary:\n${text}`).toBe(false);
}

describe('the guarantee', () => {
  test('no text a session wrote, and no field a user set, reaches the report or its link', () => {
    const dir = canaryDataDir();
    try {
      const facts = canaryFacts(dir);
      const { full, linked, url } = buildBugReport('The agent stopped answering after I switched sessions.', facts);
      for (const [where, text] of [
        ['title', full.title], ['report', full.report], ['linked report', linked.report],
        ['url', url], ['decoded url', decodeURIComponent(url.replace(/\+/g, ' '))],
      ] as const) {
        expectNoCanary(text, where);
      }
      // What the shapes do say, from the same sources.
      expect(full.report).toContain('provider: openai-compatible · model: custom');
      expect(full.report).toContain('modules: subagents, wake · custom: 2');
      expect(full.report).toContain('server 1: a local command · stdio · legacy · connected · 4 tools');
      expect(full.report).toContain('server 2: @animalabs/discord-mcpl@1.2.3 · stdio · legacy · retrying · 0 tools');
      expect(full.report).toContain('server 5: a registry package · stdio · legacy · connected · 1 tools');
      expect(full.report).toContain('server 3: a registry package · stdio · legacy · connected · 2 tools');
      expect(full.report).toContain('server 4: a url server · websocket · legacy · refused · 0 tools');
      expect(full.report).toContain('Provider calls, last hour: 3, 2 failed');
      // No provider key, and the setup's provider isn't one whose writer omits it.
      expect(full.report).toContain('2026-10-11T23:40:00Z stream ? 529 server retryable overloaded_error');
      expect(full.report).toContain('2026-10-11T23:45:00Z stream ? 400 ? not retryable other');
      expect(full.report).toContain('tags: mcpl 2, routing 1, other 1');
      expect(full.report).toContain('TypeError ×1');
      expect(full.report).toContain('connectome-host/src/commands.ts:12');
      expect(full.report).toContain('another error class ×1');
      expect(full.report).toContain('connectome-host/src/commands.ts:40');
      // The session's file is no frame: the error is named, with no location.
      expect(full.report).toMatch(/ReferenceError ×1 · sig [0-9a-f]{8}\n\n/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the command's output and the file it saves carry none of it either", () => {
    const dir = canaryDataDir();
    const previous = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    try {
      const recipe = canaryRecipe();
      const app = {
        framework: {
          listMcplServers: () => LIVE,
          getAllModules: () => [{ name: 'webui' }, { name: 'subscription-gc' }, { name: `${CANARY}-extension` }],
          getAgent: () => undefined,
          getAllAgents: () => [{ model: `${CANARY}-model`, maxTokens: 4096, thinking: { enabled: false }, proseRouting: 'hybrid', cacheTtl: '5m' }],
        } as unknown as AgentFramework,
        sessionManager: {} as never,
        recipe: recipe as never,
        branchState: createBranchState(),
        switchSession: async () => {},
      };
      // Read as any command is: the first character dropped, then the name.
      const result = handleCommand('/ bug  It froze when the Discord server reconnected.', app);
      const output = result.lines.map((line) => line.text).join('\n');
      expectNoCanary(output.replace(dir, '<dir>'), 'the command output');
      expect(output).toContain('nothing has been sent');
      // The running setup: the live agent's fields and the registered modules.
      expect(output).toContain('maxTokens: 4096');
      expect(output).toContain('proseRouting: hybrid · thinking: off');
      expect(output).toContain('modules: wake, subscription-gc, webui · custom: 1');
      expect(output).toContain('  It froze when the Discord server reconnected.');
      expect(output).toContain('https://github.com/anima-research/connectome-host/issues/new?template=bug_report.yml');
      const saved = readdirSync(dir).filter((name) => name.startsWith('bug-report-'));
      expect(saved.length).toBe(1);
      expectNoCanary(readFileSync(join(dir, saved[0]!), 'utf8'), 'the saved file');
    } finally {
      if (previous === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a model id goes in only when every word of it is a public model word, a number or a date', () => {
    expect(publicModelId('anthropic', 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(publicModelId('anthropic', 'claude-3-5-sonnet-20240620')).toBe('claude-3-5-sonnet-20240620');
    expect(publicModelId('bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(publicModelId('openai-responses', 'gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(publicModelId('openai-codex', 'o3')).toBe('o3');
    expect(publicModelId('openrouter', 'anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
    expect(publicModelId('openrouter', 'meta-llama/llama-3.1-70b-instruct')).toBe('meta-llama/llama-3.1-70b-instruct');
    // A user's words after a public-looking prefix, or an unknown vendor.
    expect(publicModelId('anthropic', `claude-${CANARY}`)).toBe('custom');
    expect(publicModelId('bedrock', `anthropic.claude-${CANARY}`)).toBe('custom');
    expect(publicModelId('openai-responses', `gpt-${CANARY}`)).toBe('custom');
    expect(publicModelId('openrouter', `${CANARY}/secret-model`)).toBe('custom');
    expect(publicModelId('openrouter', `openai/${CANARY}`)).toBe('openai/custom');
    expect(publicModelId('bedrock', 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/x')).toBe('custom');
    expect(publicModelId('openai-compatible', 'claude-sonnet-4-5')).toBe('custom');
    expect(publicModelId('anthropic', undefined)).toBe(null);
  });

  test('versions and the OS release keep their numeric core only', () => {
    const root = scratch();
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: `0.9.0-${CANARY}` }));
      const facts = gatherBugReportFacts({ now: NOW, mode: 'batch', dataDir: root, recipe: {}, liveServers: [], serverConfig: () => undefined, root });
      expect(facts.host.version).toBe('0.9.0');
      expect(facts.runtime.release === null || /^\d+(\.\d+)+$/.test(facts.runtime.release)).toBe(true);
      expectNoCanary(buildBugReport('x', facts).full.report, 'the report');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the shapes', () => {
  test('the error log is read from its current session only, as tags and error shapes', () => {
    const exists = () => true;
    const session = currentSession([
      '--- session 2026-10-11T22:00:00.000Z ---',
      '[mcpl] old',
      '--- session 2026-10-11T23:00:00.000Z ---',
      '[2026-10-11T23:00:01.000Z] [shutdown] stopping',
      '[MCPL] upper-case tag',
      '[weird tag with spaces] not a tag',
      'RangeError: out of range',
      `    at a (${join(ROOT, 'src/a.ts')}:1:1)`,
      `    at b (${join(ROOT, 'src/b.ts')}:2:1)`,
      `    at c (${join(ROOT, 'src/c.ts')}:3:1)`,
      `    at d (${join(ROOT, 'src/d.ts')}:4:1)`,
      'RangeError: out of range again',
      `    at a (${join(ROOT, 'src/a.ts')}:1:1)`,
      `    at b (${join(ROOT, 'src/b.ts')}:2:1)`,
      `    at c (${join(ROOT, 'src/c.ts')}:3:1)`,
      'error: Bun prints uncaught errors this way',
      `    at e (file://${join(ROOT, 'src/e.ts')}:5:1)`,
      `    at f (${join(ROOT, 'node_modules/@animalabs/agent-framework/dist/src/framework.js')}:9:1)`,
    ].join('\n'));
    expect(session.includes('old')).toBe(false);
    const parsed = parseErrorLog(session, fakeScope());
    expect([...parsed.tags.entries()]).toEqual([['shutdown', 1], ['mcpl', 1]]);
    expect(parsed.otherTags).toBe(0);
    expect(parsed.errors.map((e) => [e.className, e.count, e.frames])).toEqual([
      ['RangeError', 2, ['connectome-host/src/a.ts:1', 'connectome-host/src/b.ts:2', 'connectome-host/src/c.ts:3']],
      ['an unnamed error', 1, ['connectome-host/src/e.ts:5', '@animalabs/agent-framework/dist/src/framework.js:9']],
    ]);
    expect(parsed.errors[0]!.signature).toMatch(/^[0-9a-f]{8}$/);
    // The same shape gives the same signature: a repeat is one search away.
    expect(parseErrorLog(session, fakeScope()).errors[0]!.signature).toBe(parsed.errors[0]!.signature);
  });

  test('a frame names our code only: a real file, in a code directory, at a root our code is installed at', () => {
    const scope = frameScope(ROOT);
    const parsed = parseErrorLog([
      'TypeError: x',
      `    at a (${join(ROOT, 'src/commands.ts')}:3:1)`,
      `    at b (${join(ROOT, 'src/not-a-real-file.ts')}:3:1)`,
      `    at c (/elsewhere/project/src/commands.ts:3:1)`,
      `    at d (${join(ROOT, 'node_modules/left-pad/index.js')}:3:1)`,
    ].join('\n'), scope);
    expect(parsed.errors[0]!.frames).toEqual(['connectome-host/src/commands.ts:3']);
    // A directory merely named node_modules/@animalabs/<package>/src, made
    // by a session somewhere else, isn't where the package is installed.
    const fake = join(SESSION_FILE_DIR, 'node_modules/@animalabs/agent-framework/src');
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, `${CANARY}-client.js`), '// a session wrote this\n');
    const elsewhere = parseErrorLog(['TypeError: x', `    at a (${join(fake, `${CANARY}-client.js`)}:1:1)`].join('\n'), scope);
    expect(elsewhere.errors[0]!.frames).toEqual([]);
    // The scope found where agent-framework is actually installed, wherever
    // the install put it (a workspace may hoist it above the checkout).
    const installed = scope.packageRoots.get('agent-framework');
    expect(installed).toBeDefined();
    expect(installed).toBe(realpathSync(installed!));
    expect(JSON.parse(readFileSync(join(installed!, 'package.json'), 'utf8')).name).toBe('@animalabs/agent-framework');
  });

  test('installed without git, a frame still names only a real file in a code directory', () => {
    const root = scratch();
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'data'));
      writeFileSync(join(root, 'src/real.ts'), '// ours\n');
      writeFileSync(join(root, `data/${CANARY}-scene.js`), '// a session wrote this\n');
      const scope = frameScope(root);
      expect(scope.tracked).toBe(null);
      const parsed = parseErrorLog([
        'TypeError: x',
        `    at a (${join(root, 'src/real.ts')}:2:1)`,
        `    at b (${join(root, `data/${CANARY}-scene.js`)}:1:1)`,
        `    at c (${join(root, `src/${CANARY}-missing.ts`)}:1:1)`,
      ].join('\n'), scope);
      expect(parsed.errors[0]!.frames).toEqual(['connectome-host/src/real.ts:2']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('from a checkout, a frame names only a file git tracks', () => {
    const root = scratch();
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/tracked.ts'), '// tracked\n');
      const git = (...args: string[]) => Bun.spawnSync(['git', '-C', root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
      git('init', '-q');
      git('add', 'src/tracked.ts');
      git('commit', '-q', '-m', 'x');
      writeFileSync(join(root, `src/${CANARY}.ts`), '// a session wrote this\n');
      const parsed = parseErrorLog([
        'TypeError: x',
        `    at a (${join(root, 'src/tracked.ts')}:2:1)`,
        `    at b (${join(root, `src/${CANARY}.ts`)}:1:1)`,
      ].join('\n'), frameScope(root));
      expect(parsed.errors[0]!.frames).toEqual(['connectome-host/src/tracked.ts:2']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('provider calls: the last hour, by classification only', () => {
    const line = (t: string, fields: Record<string, unknown>) => JSON.stringify({ timestamp: t, kind: 'complete', ...fields });
    const summary = summarizeProviderCalls([
      line('2026-10-11T22:40:00.000Z', { type: 'error', httpStatus: 500 }),
      line('2026-10-11T23:10:00.000Z', { type: 'call' }),
      line('2026-10-11T23:20:00.000Z', { type: 'error', provider: 'bedrock', httpStatus: 429, errorType: 'rate_limit', retryable: true, providerErrorCode: 'ThrottlingException' }),
      line('2026-10-11T23:30:00.000Z', { type: 'error', httpStatus: 9999, errorType: 'made-up', providerErrorCode: 'whatever the provider said' }),
      // A cache keepalive poke the provider rejected.
      line('2026-10-11T23:35:00.000Z', { type: 'error', kind: 'keepalive', httpStatus: 400 }),
      'not json',
      JSON.stringify({ type: 'error', timestamp: 'yesterday' }),
    ], NOW);
    expect(summary.calls).toBe(4);
    expect(summary.failed).toBe(3);
    expect(summary.recent).toEqual([
      { at: '2026-10-11T23:35:00Z', kind: 'keepalive', provider: null, status: 400, type: null, retryable: null, code: null },
      { at: '2026-10-11T23:30:00Z', kind: 'complete', provider: null, status: null, type: null, retryable: null, code: 'other' },
      { at: '2026-10-11T23:20:00Z', kind: 'complete', provider: 'bedrock', status: 429, type: 'rate_limit', retryable: true, code: 'ThrottlingException' },
    ]);
  });

  test("the framework's own family and transport come first; with no configuration, the live entry's command or url by presence", () => {
    const rows = serverRows(
      [
        { id: 'h', family: 'modern', transport: 'http', url: `https://${CANARY}.example/mcp`, connected: true, toolCount: 1 },
        { id: 'deployed', command: `/home/${CANARY}/bin/x`, connected: true, toolCount: 2 },
        { id: 'odd', family: CANARY, transport: CANARY },
      ],
      (id) => (id === 'h' ? { url: `https://${CANARY}.example/mcp` } : undefined),
    );
    expect(rows).toEqual([
      { kind: 'a url server', transport: 'http', family: 'modern', connected: true, retrying: false, refused: false, toolCount: 1 },
      { kind: 'a local command', transport: 'stdio', family: 'legacy', connected: true, retrying: false, refused: false, toolCount: 2 },
      { kind: 'unknown', transport: 'unknown', family: 'unknown', connected: false, retrying: false, refused: false, toolCount: 0 },
    ]);
    expectNoCanary(JSON.stringify(rows), 'the rows');
    // agent-framework #262 gives a refused server null family and transport:
    // it has none it could use, whatever its configuration says.
    const [refused] = serverRows(
      [{ id: 'r', family: null, transport: null, refused: 'a sentence', url: 'x' }],
      () => ({ url: 'wss://h/x' }),
    );
    expect(refused).toMatchObject({ kind: 'a url server', transport: 'unknown', family: 'unknown', refused: true });
  });

  test("servers are configured as startup composes them: the file, the recipe's overrides, then the overlay", () => {
    const dir = scratch();
    try {
      const file = join(dir, 'mcpl-servers.json');
      const overlay = join(dir, 'mcpl-servers.agent.json');
      writeFileSync(file, JSON.stringify({ mcplServers: { adopted: { command: 'node', transport: 'stdio' } } }));
      // A recipe adopting a file server may move it to WebSocket; a server
      // the recipe defines itself keeps its own fields, its source included.
      const recipe = {
        adopted: { url: 'wss://h/x', transport: 'websocket' },
        ours: { command: 'node', source: { npm: '@animalabs/discord-mcpl@1.2.3' } },
      };
      const before = composedServerConfigs(recipe, file, overlay);
      expect(before.notes).toEqual([]);
      expect(serverRows([{ id: 'adopted' }], before.configFor)[0]).toMatchObject({ kind: 'a url server', transport: 'websocket' });
      expect(serverRows([{ id: 'ours' }], before.configFor)[0]!.kind).toBe('@animalabs/discord-mcpl@1.2.3');
      // An overlay entry that replaces a server is its whole configuration.
      writeFileSync(overlay, JSON.stringify({ mcplServers: { ours: { command: '/usr/local/bin/my-own' } } }));
      expect(serverRows([{ id: 'ours' }], composedServerConfigs(recipe, file, overlay).configFor)[0]!.kind).toBe('a local command');
      // A file that can't be read is named, without its path.
      writeFileSync(overlay, '{ not json');
      expect(composedServerConfigs(recipe, file, overlay).notes).toEqual(["the agent overlay couldn't be read"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('servers are rows by ordinal, and only our own packages are named', () => {
    const rows = serverRows(
      [{ id: 'a', connected: true, toolCount: 3 }, { id: 'b' }, { id: 'c', refused: 'a sentence' }],
      (id) => ({
        a: { source: { npm: '@animalabs/heartbeat-mcpl@0.2.0' }, command: 'node' },
        b: { url: 'ws://localhost:1234/x' },
        c: { url: 'http://h/x', transport: 'stdio', command: 'x' },
      } as Record<string, object>)[id],
    );
    expect(rows).toEqual([
      { kind: '@animalabs/heartbeat-mcpl@0.2.0', transport: 'stdio', family: 'legacy', connected: true, retrying: false, refused: false, toolCount: 3 },
      { kind: 'a url server', transport: 'websocket', family: 'legacy', connected: false, retrying: false, refused: false, toolCount: 0 },
      { kind: 'a url server', transport: 'stdio', family: 'legacy', connected: false, retrying: false, refused: true, toolCount: 0 },
    ]);
  });

  test("every tag connectome-host's own strings begin with is a named tag", () => {
    const src = join(ROOT, 'src');
    const tags = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          // Any string our code begins with a bracketed tag: a log call's, a
          // logger's, or a constant's.
          for (const match of readFileSync(path, 'utf8').matchAll(/[`'"]\[([a-z0-9:_-]{1,40})\][ `'"]/gi)) {
            tags.add(match[1]!.toLowerCase());
          }
        }
      }
    };
    walk(src);
    const missing = [...tags].filter((tag) => !HOST_LOG_TAGS.has(tag));
    expect(missing).toEqual([]);
  });
});

describe('the link', () => {
  test("fills the form's two fields by id, names the form, and never asks for labels", () => {
    const dir = canaryDataDir();
    try {
      const { url } = buildBugReport('It crashed.', canaryFacts(dir));
      const params = new URL(url).searchParams;
      expect([...params.keys()]).toEqual(['template', 'title', 'what', 'report']);
      expect(params.get('template')).toBe('bug_report.yml');
      expect(params.get('title')).toBe('[/bug] It crashed.');
      expect(params.get('report')!.startsWith(BUG_REPORT_MARKER)).toBe(true);
      const form = readFileSync(join(ROOT, '.github/ISSUE_TEMPLATE/bug_report.yml'), 'utf8');
      const blocks = form.split(/\n  - type: /).slice(1).map((block) => `type: ${block}`);
      const field = (id: string) => blocks.find((block) => new RegExp(`\\n    id: ${id}\\n`).test(block));
      expect(field('what')?.startsWith('type: textarea')).toBe(true);
      expect(field('report')?.startsWith('type: textarea')).toBe(true);
      expect(field('report')).toMatch(/\n      render: text\n/);
      expect(form).toMatch(/^labels: \["bug"\]$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stays within its cap: the lists collapse first, then the text is cut, each saying so', () => {
    const dir = canaryDataDir();
    try {
      const facts = canaryFacts(dir);
      const long = `${'A long account of what happened. '.repeat(400)}`;
      const { full, linked, url, cut } = buildBugReport(long, facts);
      expect(url.length).toBeLessThanOrEqual(BUG_REPORT_URL_CAP);
      expect(cut).toEqual(['the server rows, the failure list and the error frames', 'part of "What happened"']);
      expect(linked.what).toMatch(/\[\d+ characters cut to fit the link; the whole text is in the report file\]$/);
      expect(full.what).toBe(long);
      expect(bugReportUrl(full).length).toBeGreaterThan(BUG_REPORT_URL_CAP);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a title is the first line, cut at 80 characters', () => {
    const dir = canaryDataDir();
    try {
      const { full } = buildBugReport(`\n${'x'.repeat(120)}\nsecond line`, canaryFacts(dir));
      expect([...full.title].length).toBe('[/bug] '.length + 80);
      expect(full.title.endsWith('…')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the mode', () => {
  test("follows index.ts's rule", () => {
    expect(runtimeMode(['bun', 'src/index.ts', '--headless'], false)).toBe('headless');
    expect(runtimeMode(['bun', 'src/index.ts'], false)).toBe('batch');
    expect(runtimeMode(['bun', 'src/index.ts', '--no-tui'], true)).toBe('readline');
    expect(runtimeMode(['bun', 'src/index.ts', '--no-tui'], false)).toBe('batch');
    expect(runtimeMode(['bun', 'src/index.ts'], true)).toBe('tui');
  });

  test('headless reads headless.log; readline and batch have no error log', () => {
    const dir = canaryDataDir();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'headless.log'), '\n--- session 2026-10-11T23:30:00.000Z ---\n[mcpl] x\n');
      const headless = gatherBugReportFacts({ now: NOW, mode: 'headless', dataDir: dir, recipe: {}, liveServers: [], serverConfig: () => undefined });
      expect(headless.hostErrors?.log).toBe('headless.log');
      expect(headless.hostErrors?.tags).toEqual([['mcpl', 1]]);
      const batch = gatherBugReportFacts({ now: NOW, mode: 'batch', dataDir: dir, recipe: {}, liveServers: [], serverConfig: () => undefined });
      expect(batch.hostErrors).toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('who runs it', () => {
  test('the fleet tool refuses /bug, so a session never files one, in a child or here', async () => {
    const fleet = new FleetModule();
    // Whatever the child's handleCommand would run as /bug: it drops the
    // first character, whatever it is, and trims after it.
    for (const command of ['/bug it broke', '/bug', '/bug\tx', '/ bug the model wrote this', 'xbug words', '!bug words', '/\tbug x']) {
      const result = await fleet.handleToolCall({ id: 't', name: 'command', input: { name: 'any', command } } as never);
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('/bug is for a person to run');
    }
    // The handler reads those names the same way: each would run /bug.
    for (const command of ['/ bug words', 'xbug words', '/\tbug words']) {
      expect(parseCommand(command)).toEqual({ name: 'bug', rest: 'words' });
    }
    expect(parseCommand('/bug   two  spaced\nlines  ')).toEqual({ name: 'bug', rest: 'two  spaced\nlines' });
    expect(parseCommand('/')).toEqual({ name: '', rest: '' });
    // A leading space makes the name "/bug", which no command is: it runs nothing.
    expect(parseCommand('  /bug x').name).toBe('/bug');
    // Other commands still reach the child check.
    const other = await fleet.handleToolCall({ id: 't', name: 'command', input: { name: 'missing', command: '/status' } } as never);
    expect(String(other.error)).not.toContain('/bug');
  });
});

describe('what the report says about itself', () => {
  test("only this process's call log is read, and a process with none says so", () => {
    const dir = canaryDataDir();
    try {
      // canaryFacts names this process's file; the newer-named one holds a failure it must not count.
      expect(buildBugReport('x', canaryFacts(dir)).full.report).toContain('Provider calls, last hour: 3, 2 failed');
      // By default, the file index.ts named when it created it.
      setCallLogPath(join(dir, CALL_LOG));
      const named = gatherBugReportFacts({ now: NOW, mode: 'tui', dataDir: dir, recipe: {}, liveServers: [], serverConfig: () => undefined });
      expect(named.providerCalls).toMatchObject({ calls: 3, failed: 2 });
      const none = gatherBugReportFacts({ now: NOW, mode: 'tui', dataDir: dir, recipe: {}, liveServers: [], serverConfig: () => undefined, callLog: null });
      expect(buildBugReport('x', none).full.report).toContain('Provider calls: no call log in this process');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a log that can't be read says so, and one read only in part says how much", () => {
    const dir = scratch();
    try {
      // A directory where the log should be: it exists and can't be read as a file.
      mkdirSync(join(dir, 'tui-error.log'));
      const unreadable = gatherBugReportFacts({ now: NOW, mode: 'tui', dataDir: dir, recipe: {}, liveServers: [], serverConfig: () => undefined, callLog: null });
      expect(buildBugReport('x', unreadable).full.report).toContain("Host errors: tui-error.log couldn't be read");
      rmSync(join(dir, 'tui-error.log'), { recursive: true });
      writeFileSync(join(dir, 'tui-error.log'), `${'x'.repeat(4 * 1024 * 1024 + 10)}\n[mcpl] after\n`);
      const big = gatherBugReportFacts({ now: NOW, mode: 'tui', dataDir: dir, recipe: {}, liveServers: [], serverConfig: () => undefined, callLog: null });
      expect(buildBugReport('x', big).full.report).toContain("(only tui-error.log's last 4 MiB were read)");
      expect(tailLines(join(dir, 'missing.log'), 10)).toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a servers file or overlay that couldn't be read is named, without its path", () => {
    const facts = { ...canaryFactsless(), configNotes: ["the servers file couldn't be read"] };
    expect(formatBugReport('x', facts).report).toContain("(the servers file couldn't be read)");
  });

  test('a record with no provider takes the setup\'s, only for the writers that omit it', () => {
    const line = JSON.stringify({ type: 'error', timestamp: '2026-10-11T23:40:00.000Z', httpStatus: 529 });
    expect(summarizeProviderCalls([line], NOW, { fallbackProvider: 'anthropic' }).recent[0]!.provider).toBe('anthropic');
    expect(summarizeProviderCalls([line], NOW).recent[0]!.provider).toBe(null);
    const facts = gatherBugReportFacts({
      now: NOW, mode: 'batch', dataDir: scratch(), recipe: { agent: { provider: 'anthropic' } }, liveServers: [],
      serverConfig: () => undefined, callLog: null,
    });
    expect(facts.setup.provider).toBe('anthropic');
  });

  test('records with no time, a time ahead of now, or no JSON are counted as unreadable; the list keeps its newest', () => {
    const at = (minute: number) => `2026-10-11T23:${String(minute).padStart(2, '0')}:00.000Z`;
    const lines = [
      ...Array.from({ length: 12 }, (_, i) => JSON.stringify({ type: 'error', timestamp: at(i + 1), httpStatus: 500 })),
      JSON.stringify({ type: 'error', timestamp: '2026-10-12T05:00:00.000Z' }),
      'not json',
      JSON.stringify({ type: 'error' }),
    ];
    const summary = summarizeProviderCalls(lines, NOW, { recentMax: 10 });
    expect(summary).toMatchObject({ calls: 12, failed: 12, skipped: 3, omitted: 2 });
    expect(summary.recent[0]!.at).toBe('2026-10-11T23:12:00Z');
    expect(summary.recent).toHaveLength(10);
  });
});

describe('the shapes, at their edges', () => {
  test('a frame path with spaces or parentheses still resolves, read from the end', () => {
    expect(frameLocation('    at fn (/home/A B/x (1)/src/a.ts:12:3)')).toEqual({ path: '/home/A B/x (1)/src/a.ts', line: '12' });
    expect(frameLocation('    at /opt/app/src/b.ts:4:1')).toEqual({ path: '/opt/app/src/b.ts', line: '4' });
    expect(frameLocation('    at fn (node:internal/x:1:1)')).toBe(null);
    expect(frameLocation('not a frame')).toBe(null);
  });

  test("a multi-line message stays one error with its frames, however long, until a new record begins", () => {
    const parsed = parseErrorLog([
      'TypeError: first line of the message',
      ...Array.from({ length: 8 }, (_, i) => `line ${i + 2} of the message`),
      '',
      `    at a (${join(ROOT, 'src/commands.ts')}:3:1)`,
    ].join('\n'), fakeScope());
    expect(parsed.errors.map((e) => [e.className, e.count, e.frames])).toEqual([['TypeError', 1, ['connectome-host/src/commands.ts:3']]]);
    // A tagged line is a new record: the frames after it aren't the TypeError's.
    const split = parseErrorLog([
      'TypeError: x',
      '[mcpl] something else',
      `    at a (${join(ROOT, 'src/commands.ts')}:3:1)`,
    ].join('\n'), fakeScope());
    expect(split.errors.map((e) => e.className).sort()).toEqual(['TypeError', 'an unnamed error']);
  });

  test('the session marker the runtimes write is the one the reader finds', () => {
    const marker = sessionMarker(NOW);
    expect(currentSession(`old\n${marker}\nnew`)).toBe('new');
    for (const file of ['src/tui.ts', 'src/headless.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8')).toContain('sessionMarker(new Date())');
    }
  });

  test('values outside the setup lists stay out', () => {
    const recipe = canaryRecipe('claude-sonnet-4-5');
    const agent = recipe.agent as Record<string, unknown>;
    agent.provider = CANARY;
    agent.formatter = CANARY;
    agent.cacheTtl = CANARY;
    agent.proseRouting = CANARY;
    const dir = canaryDataDir();
    try {
      const { full } = buildBugReport('x', canaryFacts(dir, 'tui', recipe));
      expectNoCanary(full.report, 'the report');
      expect(full.report).toContain('provider: other · model: custom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the environment: versions, commit and modified flag, from a real checkout', () => {
    const root = scratch();
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
      mkdirSync(join(root, 'node_modules/@animalabs/agent-framework'), { recursive: true });
      writeFileSync(join(root, 'node_modules/@animalabs/agent-framework/package.json'), JSON.stringify({ version: '0.21.0' }));
      const git = (...args: string[]) => Bun.spawnSync(['git', '-C', root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
      git('init', '-q');
      git('add', 'package.json');
      git('commit', '-q', '-m', 'x');
      const facts = () => gatherBugReportFacts({ now: NOW, mode: 'batch', dataDir: root, recipe: {}, liveServers: [], serverConfig: () => undefined, callLog: null, root });
      const clean = facts();
      expect(clean.host.version).toBe('1.2.3');
      expect(clean.host.commit?.modified).toBe(false);
      expect(clean.host.commit?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(clean.packages.find((p) => p.name === '@animalabs/agent-framework')?.version).toBe('0.21.0');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.4' }));
      expect(facts().host.commit?.modified).toBe(true);
      expect(formatBugReport('x', clean).report).toContain(`connectome-host 1.2.3 (commit ${clean.host.commit!.sha.slice(0, 12)}, modified: no) · mode: batch`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the link, at its edges', () => {
  test('punctuation-heavy text, many servers and a lone surrogate still fit the cap', () => {
    const dir = canaryDataDir();
    try {
      const many = { ...canaryFacts(dir), servers: Array.from({ length: 300 }, () => ({ kind: 'a local command', transport: 'stdio' as const, family: 'legacy' as const, connected: true, retrying: false, refused: false, toolCount: 3 })) };
      for (const text of ["(it's) !~".repeat(900), `bad \uD800 surrogate ${'x'.repeat(100)}`, 'short']) {
        const { url, linked } = buildBugReport(text, many);
        expect(url.length).toBeLessThanOrEqual(BUG_REPORT_URL_CAP);
        expect(linked.report).toContain('MCP servers: 300 (connected 300)');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the brief form says what it leaves out, and is bounded', () => {
    const dir = canaryDataDir();
    try {
      const facts = canaryFacts(dir);
      const brief = formatBugReport('x', facts, 'brief').report;
      expect(brief).toContain('(the failures are listed in the saved report, not in this link)');
      expect(brief).not.toContain('connectome-host/src/commands.ts:12');
      expect(brief).toContain('MCP servers: 5 (connected 3, retrying 1, refused 1)');
      // Three errors at most, by class and signature, without frames.
      expect(brief.match(/ sig [0-9a-f]{8}/g)?.length).toBe(3);
      expect(brief).not.toMatch(/^    connectome-host\//m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a cut is named only when it removed something', () => {
    const bare = canaryFactsless();
    const { cut } = buildBugReport('y'.repeat(8000), bare);
    expect(cut).toEqual(['part of "What happened"']);
  });

  test('a title is cut at 80 code points, astral characters included', () => {
    const { full } = buildBugReport('😀'.repeat(79), canaryFactsless());
    expect(full.title).toBe(`[/bug] ${'😀'.repeat(79)}`);
    const long = buildBugReport('😀'.repeat(81), canaryFactsless()).full.title;
    expect([...long].length).toBe('[/bug] '.length + 80);
  });
});

/** Facts with nothing in their lists. */
function canaryFactsless(): BugReportFacts {
  return gatherBugReportFacts({ now: NOW, mode: 'batch', dataDir: scratch(), recipe: {}, liveServers: [], serverConfig: () => undefined, callLog: null });
}

describe('the running setup and the saved file', () => {
  test("the running agent's fields and modules come before the recipe's", () => {
    const recipe = { agent: { provider: 'anthropic', model: 'claude-opus-4-6', maxTokens: 1000, thinking: { enabled: true } }, modules: { lessons: true } };
    const facts = setupFacts(recipe, {
      agent: { model: 'claude-sonnet-4-5', maxTokens: 2000, thinking: { enabled: false } },
      modules: ['subscription-gc', 'lessons', `${CANARY}-ext`, 'workspace'],
      wake: true,
    });
    expect(facts).toMatchObject({ model: 'claude-sonnet-4-5', maxTokens: 2000, thinking: false, modules: ['wake', 'lessons', 'subscription-gc', 'workspace'], customModules: 1 });
    expectNoCanary(JSON.stringify(facts), 'the setup');
    // Without a running framework's word, the recipe's.
    expect(setupFacts(recipe)).toMatchObject({ model: 'claude-opus-4-6', maxTokens: 1000, thinking: true, modules: ['lessons'] });
  });

  test("when the file can't be saved, the output says so and promises nothing of it", () => {
    const dir = scratch();
    const previous = process.env.DATA_DIR;
    // A data directory under a file can't be made.
    writeFileSync(join(dir, 'a-file'), '');
    process.env.DATA_DIR = join(dir, 'a-file', 'data');
    try {
      const app = {
        framework: { listMcplServers: () => [], getAllModules: () => [], getAgent: () => undefined, getAllAgents: () => [] } as unknown as AgentFramework,
        sessionManager: {} as never,
        recipe: {} as never,
        branchState: createBranchState(),
        switchSession: async () => {},
      };
      const short = handleCommand('/bug it broke', app).lines.map((line) => line.text).join('\n');
      expect(short).toContain("Couldn't save it to a file");
      expect(short).toContain('The link below holds the whole report.');
      expect(short).not.toContain('Saved to');
      const long = handleCommand(`/bug ${'y'.repeat(9000)}`, app).lines.map((line) => line.text).join('\n');
      expect(long).toContain("The file couldn't be saved, so copy the full report above into the issue.");
      expect(long).not.toContain('The link below holds the whole report.');
      expect(long).not.toContain('saved file holds');
    } finally {
      if (previous === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
