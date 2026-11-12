import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm, stat, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModuleContext, ToolCall, ToolResult, TraceEvent, ToolDefinition } from '@animalabs/agent-framework';
import { AgentFramework, type Module } from '@animalabs/agent-framework';
import { Membrane, MockAdapter } from '@animalabs/membrane';
import { NoticesModule } from '../src/modules/notices-module.js';
import type { NoticeHomeConfig } from '../src/notice-home-config.js';
import { validateRecipe } from '../src/recipe.js';
import { forkSchema, literalForkDisplay } from './fixtures/notice-home/fork-contract.js';

const binding = (): NoticeHomeConfig => ({ connector: 'zulip', logicalAgent: 'pilot', serverId: 'chat-ops',
  toolPrefix: 'mcpl--chat-ops', declaredRealm: 'https://example.invalid', stream: 'private-ops',
  statusTopic: 'agent status', incidentsTopic: 'agent incidents', trustMode: 'operator-attested-unverified', selfEchoPreflight: 'operator-attested' });
const schema = (): ToolDefinition['inputSchema'] => ({ type: 'object', properties: {
  type: { type: 'string', enum: ['stream', 'private'] }, to: { type: 'string' }, topic: { type: 'string' }, content: { type: 'string' },
  attachments: { type: 'array', items: { type: 'object', properties: { data: { type: 'string' }, name: { type: 'string' }, mime_type: { type: 'string' } } } },
} });
const dirs: string[] = [];
const running: NoticesModule[] = [];
afterEach(async () => {
  for (const m of running.splice(0)) await m.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function scratch() { const d = await mkdtemp(join(tmpdir(), 'host-notice-home-')); dirs.push(d); return d; }
async function journal(dir: string): Promise<any> { return JSON.parse(await readFile(join(dir, 'journal.json'), 'utf8')); }

async function harness(options: { dir?: string; config?: NoticeHomeConfig; instance?: string; sendTimeoutMs?: number; setup?: (h: any) => void } = {}) {
  const dir = options.dir ?? await scratch();
  const config = options.config ?? binding();
  let listener: (event: any) => void = () => {};
  let t = 100;
  const calls: ToolCall[] = [];
  const forbidden: string[] = [];
  const trap = (name: string) => () => { forbidden.push(name); throw new Error(`forbidden ${name}`); };
  const h = {
    dir, config, calls, forbidden,
    // Observable fake core hooks: the adapter must never use them.
    core: { locus: 'chat:user-conversation', open: ['chat:normal'], admission: 'normal' },
    servers: [{ id: config.serverId, connected: true, toolPrefix: config.toolPrefix,
      toolClasses: [{ tool: `${config.toolPrefix}--send_message`, serverTool: 'send_message' }] }] as any[],
    tools: [{ name: `${config.toolPrefix}--send_message`, description: 'offline fake', inputSchema: schema() }] as any[],
    status: 'idle', primaryActive: false, failures: 0, refusalTotal: 0, readFailure: false,
    result: async (_call: ToolCall): Promise<ToolResult> => ({ success: true, data: [{ type: 'text', text: JSON.stringify({ result: 'success', id: calls.length }) }] }),
    emit: (event: Record<string, unknown>) => listener(event),
    alert: (kind: string, message = 'diagnostic', timestamp = ++t, extra = {}) => listener({ type: 'ops:alert', kind, message, agentName: 'worker', timestamp, ...extra }),
    trace: (type: string) => listener({ type, agentName: 'worker', timestamp: ++t }),
    tick: () => ++t,
    inspectThrows: false,
    early: [] as Record<string, unknown>[],
  };
  options.setup?.(h);
  const ctx = {
    getState: trap('getState/checkpoint'), setState: trap('setState/checkpoint'), addMessage: trap('addMessage'),
    pushEvent: trap('pushEvent'), requestInference: trap('requestInference'),
    callTool: async (call: ToolCall) => {
      // This is the real NoticesModule -> delivery adapter -> ctx.callTool
      // boundary, not a formatter/helper-only assertion. No API/network.
      calls.push(call);
      const j = await journal(dir);
      expect(j.records.find((r: any) => `notice-home-${r.id}` === call.id)?.outcome.state).toBe('intent');
      return h.result(call);
    },
  } as unknown as ModuleContext;
  const framework = {
    onTrace: (fn: (event: any) => void, options?: { replay?: boolean }) => {
      listener = fn;
      if (options?.replay) for (const event of h.early) fn(event);
      return () => { listener = () => {}; };
    },
    listMcplServers: () => { if (h.inspectThrows) throw new Error('fake inspection failure'); return h.servers; },
    getAllTools: () => h.tools,
    healthSnapshot: () => {
      if (h.readFailure) throw new Error('must not capture raw health error/request');
      return { at: t, agents: [{ name: 'worker', status: h.status, consecutiveInferenceFailures: h.failures,
        refusalStats: { total: h.refusalTotal }, providerAdmission: { primaryActive: h.primaryActive, primaryPending: false, hostHold: false,
          auxiliaryInFlight: 0, auxiliaryDeferred: 0, heldRequests: 0 } }],
        gate: { secretRequestBody: 'NEVER-CAPTURE-HEALTH' }, pendingRequests: [{ body: 'NEVER-CAPTURE-REQUEST' }] };
    },
    getAgent: trap('getAgent/model'), requestInference: trap('framework.requestInference'),
    channels: { publishForAgent: trap('publishForAgent'), open: trap('channel_open'), setLocus: trap('setLocus') },
  };
  const module = new NoticesModule({ agentName: 'worker', home: config, homeRuntime: {
    directory: dir, instanceId: options.instance ?? 'instance-A', sendTimeoutMs: options.sendTimeoutMs ?? 25,
  }, now: () => t });
  running.push(module);
  await module.start(ctx);
  module.setFramework(framework as never);
  await module.homeSettled();
  return { ...h, state: h, module, framework, settle: () => module.homeSettled() };
}

describe('service-home recipe', () => {
  const recipe = (notices: unknown) => ({ name: 'synthetic', agent: { systemPrompt: 'offline' }, modules: { notices } });
  test('explicit attested binding is typed/validated, legacy omission is unchanged', () => {
    expect(validateRecipe(recipe({ home: binding() })).modules?.notices).toEqual({ home: binding() });
    expect(validateRecipe(recipe(true)).modules?.notices).toBe(true);
    expect(validateRecipe(recipe({ statusChannels: ['zulip:legacy'] })).modules?.notices).toEqual({ statusChannels: ['zulip:legacy'] });
  });
  test('rejects missing/false attestation, guessed defaults, bad realm, topics and mixed legacy routing', () => {
    for (const key of Object.keys(binding())) {
      const value = { ...binding() } as any; delete value[key];
      expect(() => validateRecipe(recipe({ home: value }))).toThrow(/modules.notices.home/);
    }
    for (const change of [{ trustMode: 'verified' }, { selfEchoPreflight: false }, { connector: 'slack' },
      { declaredRealm: 'http://example.invalid' }, { declaredRealm: 'https://user:password@example.invalid' },
      { declaredRealm: 'https://example.invalid/' }, { declaredRealm: 'https://example.invalid/path' },
      { declaredRealm: 'https://example.invalid?token=x' }, { serverId: '*' }, { toolPrefix: 'prefix*' },
      { stream: ' ' }, { statusTopic: '' }, { statusTopic: 'x\ncommand' }, { incidentsTopic: 'agent status' }, { unexpected: 'field' }]) {
      expect(() => validateRecipe(recipe({ home: { ...binding(), ...change } }))).toThrow(/modules.notices.home/);
    }
    expect(() => validateRecipe(recipe({ home: binding(), kinds: { refusal: 'silent' } }))).toThrow(/legacy/);
  });
});

test('startup uses fixed authenticated tool/server/realm/stream/topics; intent is durable; no LLM/locus/admission effects', async () => {
  const h = await harness();
  expect(h.calls).toHaveLength(1);
  const c = h.calls[0]!;
  expect(c.name).toBe('mcpl--chat-ops--send_message');
  expect(c.input).toMatchObject({ type: 'stream', to: 'private-ops', topic: 'agent status' });
  expect(c.input).not.toHaveProperty('reply_to');
  const j = await journal(h.dir);
  expect(j.binding).toEqual(binding());
  expect(j.verification).toBe('operator-attested/unverified');
  expect(j.selfEchoReadiness).toBe('operator-attested-preflight/not-runtime-verified');
  expect(j.records[0].outcome).toEqual({ state: 'sent', messageIds: [1], serverId: 'chat-ops' });
  expect((await stat(join(h.dir, 'journal.json'))).mode & 0o777).toBe(0o600);
  expect((await stat(h.dir)).mode & 0o777).toBe(0o700);
  await h.module.onProcess({ type: 'mcpl:channel-incoming', channelId: 'other-server:latest', threadId: 'wrong topic' } as never, {} as never);
  h.alert('hard-down', 'observed model failure');
  await h.settle();
  expect(h.calls.filter((c) => (c.input as any).topic === 'agent incidents')).toHaveLength(1);
  expect(h.calls.every((c) => (c.input as any).to === 'private-ops')).toBe(true);
  expect(h.forbidden).toEqual([]);
  expect(h.core).toEqual({ locus: 'chat:user-conversation', open: ['chat:normal'], admission: 'normal' });
  expect(h.module.getTools()).toEqual([]);
});

test('meaningful health changes, unknown/readfailure and later observations; unknown is not recovery; no polling', async () => {
  const h = await harness();
  h.trace('inference:started'); await h.settle();
  expect(h.calls).toHaveLength(1); // Same observed state.
  h.state.status = 'running'; h.trace('inference:started'); await h.settle();
  expect(h.calls).toHaveLength(2);
  h.alert('novel-outage'); await h.settle();
  h.state.readFailure = true; h.trace('inference:waiting'); await h.settle();
  let j = await journal(h.dir);
  expect(j.records[j.records.length - 1].diagnostic).toContain('health-read-failed');
  expect(j.records.filter((r: any) => r.phase === 'recovery-observed')).toHaveLength(0);
  h.state.readFailure = false; h.state.status = 'idle'; h.trace('inference:completed'); await h.settle();
  j = await journal(h.dir);
  expect(j.active.map((a: any) => a.kind)).toEqual(['novel-outage']);
  expect(j.records.filter((r: any) => r.phase === 'recovery-observed')).toHaveLength(0);
  const before = h.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  expect(h.calls).toHaveLength(before);
  expect(JSON.stringify(j)).not.toContain('NEVER-CAPTURE');
});

test('startup unknown and bounded framework early ops replay are observations, not inferred health/recovery', async () => {
  const h = await harness({ setup: (h) => {
    h.readFailure = true;
    h.early = [{ type: 'ops:alert', kind: 'mcpl-down', agentName: 'other-component', timestamp: 10, message: 'startup source diagnostic' }];
  } });
  const j = await journal(h.dir);
  expect(j.records[0].kind).toBe('startup-observation');
  expect(j.records[0].diagnostic).toContain('health-read-failed');
  expect(j.records.find((r: any) => r.kind === 'mcpl-down')).toMatchObject({ subject: 'other-component', source: { timestamp: 10 } });
  expect(j.records.some((r: any) => r.phase === 'recovery-observed')).toBe(false);
});

test('omitting home makes no backend capability/health calls and creates no delivery journal', async () => {
  const dir = await scratch();
  const module = new NoticesModule({ agentName: 'worker' }); running.push(module);
  await module.start({} as ModuleContext);
  const forbidden = () => { throw new Error('legacy must not inspect home backend'); };
  module.setFramework({ onTrace: () => () => {}, listMcplServers: forbidden, getAllTools: forbidden, healthSnapshot: forbidden } as never);
  expect(module.homeState()).toBeNull();
  expect(await readdir(dir)).toEqual([]);
});

test('all observed alert kinds including refusal/unknown get generic incidents; explicit clear keeps incident ref', async () => {
  const h = await harness();
  h.alert('future-notice-kind', 'exact wording', 101, { data: { request: 'NEVER-CAPTURE-DATA', headers: { authorization: 'secret' } } });
  h.alert('refusal', 'streak 2 category unchanged', 102);
  h.alert('', 'malformed kind has honest fallback', 103);
  await h.settle();
  let j = await journal(h.dir);
  expect(j.records.filter((r: any) => r.phase === 'incident').map((r: any) => r.kind)).toEqual(['future-notice-kind', 'refusal', 'unknown-alert-kind']);
  const incident = j.records.find((r: any) => r.kind === 'future-notice-kind');
  h.alert('future-notice-kind-clear', 'explicit source clear', 104); await h.settle();
  j = await journal(h.dir);
  expect(j.records.find((r: any) => r.kind === 'future-notice-kind-clear')).toMatchObject({ phase: 'recovery-observed', incidentId: incident.incidentId });
  expect(JSON.stringify(j)).not.toContain('NEVER-CAPTURE-DATA');
  h.trace('inference:turn_ended'); await h.settle();
  expect((await journal(h.dir)).active.map((a: any) => a.kind)).toEqual(['unknown-alert-kind']);
});

test('only a matching component reconnect clears mcpl-down, not unrelated reconnect or health unknown', async () => {
  const h = await harness();
  h.alert('mcpl-down', 'component unavailable', 150, { agentName: 'component-A' }); await h.settle();
  h.emit({ type: 'mcpl:server-reconnected', serverId: 'component-B', timestamp: 151 }); await h.settle();
  expect((await journal(h.dir)).active).toHaveLength(1);
  h.state.readFailure = true;
  h.emit({ type: 'mcpl:server-reconnected', serverId: 'component-A', timestamp: 152 }); await h.settle();
  const j = await journal(h.dir);
  expect(j.active).toHaveLength(0);
  expect(j.records.find((r: any) => r.kind === 'mcpl-down-clear')).toMatchObject({
    phase: 'recovery-observed', subject: 'component-A', source: { type: 'mcpl:server-reconnected', timestamp: 152 },
  });
  expect(j.records[j.records.length - 1].diagnostic).toContain('health-read-failed');
  h.alert('mcpl-down', 'new component episode', 153, { agentName: 'component-A' }); await h.settle();
  h.emit({ type: 'module:added', moduleName: 'component-A', timestamp: 154 }); await h.settle();
  expect((await journal(h.dir)).active).toHaveLength(1);
  h.emit({ type: 'module:added', moduleName: 'mcpl:component-A', timestamp: 155 }); await h.settle();
  expect((await journal(h.dir)).active).toHaveLength(0);
});

test('diagnostic wording retained in attachment; display truncation/escaping; no credentials/arbitrary raw fields', async () => {
  const h = await harness();
  const message = 'Exact diagnostic @**all** ``` /pause\n' + 'detail '.repeat(700) + '\nAuthorization: Bearer DO-NOT-KEEP\napi_key=ALSO-SECRET';
  h.alert('new-kind', message, 201, { content: 'NEVER-CONVERSATION', response: 'NEVER-RESPONSE', reasoning: 'NEVER-REASONING' });
  await h.settle();
  const call = h.calls.find((c) => (c.input as any).topic === 'agent incidents')!;
  const input = call.input as any;
  expect(input.content).toContain('VISIBLE TRUNCATION');
  expect(input.content).not.toContain('@**all**');
  expect(input.content).not.toContain('``` /pause');
  expect(input.content.startsWith('/')).toBe(false);
  const attachment = JSON.parse(Buffer.from(input.attachments[0].data, 'base64').toString());
  expect(attachment.record.diagnostic).toContain('Exact diagnostic @**all** ``` /pause');
  expect(attachment.record.diagnostic).toContain('detail '.repeat(700));
  expect(attachment.record.diagnostic).toContain('(redacted)');
  const serialized = JSON.stringify(await journal(h.dir));
  for (const s of ['DO-NOT-KEEP', 'ALSO-SECRET', 'NEVER-CONVERSATION', 'NEVER-RESPONSE', 'NEVER-REASONING']) expect(serialized).not.toContain(s);
  expect(input.content).toContain(input.attachments[0].name);
  expect(input.content).not.toContain('file://');
});

test('diagnostic input retention cap is explicit in display/attachment, not an unbounded raw capture', async () => {
  const h = await harness();
  h.alert('future', 'x'.repeat(9000), 210); await h.settle();
  const r = (await journal(h.dir)).records.find((r: any) => r.kind === 'future');
  expect(r.diagnostic.length).toBe(8192);
  expect(r.diagnosticCapped).toBe(true);
  const input = h.calls.find((c) => (c.input as any).topic === 'agent incidents')!.input as any;
  expect(input.content).toContain('RETENTION CAP');
  expect(input.content).toContain('VISIBLE TRUNCATION');
});

test('event dedup, repeat counts/lastSeen, changed diagnostic retained; restart source/incident identity continuity', async () => {
  const h = await harness();
  h.alert('future', 'first diagnostic', 301); await h.settle();
  const sent = h.calls.length;
  h.alert('future', 'first diagnostic', 301); await h.settle();
  h.tick(); h.alert('future', 'first diagnostic', 302); await h.settle();
  expect(h.calls).toHaveLength(sent);
  let j = await journal(h.dir);
  const first = j.records.find((r: any) => r.kind === 'future');
  expect(first.count).toBe(2);
  expect(first.lastSeen).toBeGreaterThan(first.observedAt);
  h.alert('future', 'second diagnostic', 303); await h.settle();
  j = await journal(h.dir);
  const second = j.records.filter((r: any) => r.kind === 'future')[1];
  expect(second.incidentId).toBe(first.incidentId);
  await h.module.stop();
  const restarted = await harness({ dir: h.dir, instance: 'instance-B' });
  expect(restarted.calls).toHaveLength(1); // New startup observation, not old incidents.
  restarted.alert('future', 'second diagnostic', 303); await restarted.settle();
  expect(restarted.calls).toHaveLength(1);
  j = await journal(h.dir);
  expect(j.currentInstance).toBe('instance-B');
  expect(j.records.find((r: any) => r.id === first.id).instanceId).toBe('instance-A');
  expect(j.active[0].id).toBe(first.incidentId);
  restarted.alert('future-clear', 'clear', 304); await restarted.settle();
  restarted.alert('future', 'first diagnostic', 305); await restarted.settle();
  const incidents = (await journal(h.dir)).records.filter((r: any) => r.kind === 'future');
  expect(incidents[incidents.length - 1].incidentId).not.toBe(first.incidentId);
});

test('durable pending intent across instance drift becomes uncertain, never replayed, including after another restart', async () => {
  const h = await harness();
  h.alert('future', 'crash diagnostic', 401); await h.settle(); await h.module.stop();
  const j = await journal(h.dir);
  const incident = j.records.find((r: any) => r.kind === 'future');
  incident.outcome = { state: 'intent' }; // Synthetic crash after send, before outcome fsync.
  await writeFile(join(h.dir, 'journal.json'), JSON.stringify(j));
  const r = await harness({ dir: h.dir, instance: 'instance-B' });
  expect(r.calls).toHaveLength(1); // New startup only, never the old pending record.
  r.alert('future', 'crash diagnostic', 401); await r.settle();
  const saved = await journal(h.dir);
  expect(saved.records.find((x: any) => x.id === incident.id)).toMatchObject({ instanceId: 'instance-A', outcome: { state: 'uncertain' } });
  expect(saved.deliveryHalted).toBe(false);
  await r.module.stop();
  const again = await harness({ dir: h.dir, instance: 'instance-C' });
  expect(again.calls).toHaveLength(1); // Independent startup, no replay.
});

for (const [label, setup, reason] of [
  ['disconnected', (h: any) => { h.servers[0].connected = false; }, 'bound-server-unavailable'],
  ['missing server', (h: any) => { h.servers = []; }, 'bound-server-unavailable'],
  ['ambiguous server', (h: any) => { h.servers.push({ ...h.servers[0] }); }, 'bound-server-unavailable'],
  ['prefix drift', (h: any) => { h.servers[0].toolPrefix = 'another-prefix'; }, 'server-prefix-drift'],
  ['tool ownership mismatch', (h: any) => { h.servers[0].toolClasses = []; }, 'tool-not-owned-by-bound-server'],
  ['observable realm mismatch', (h: any) => { h.servers[0].realm = 'https://wrong.invalid'; }, 'observable-realm-mismatch'],
  ['no tool', (h: any) => { h.tools = []; }, 'missing-send-message-or-inline-attachment-capability'],
  ['ambiguous tool', (h: any) => { h.tools.push({ ...h.tools[0] }); }, 'missing-send-message-or-inline-attachment-capability'],
  ['no inline upload capability', (h: any) => { delete h.tools[0].inputSchema.properties.attachments; }, 'missing-send-message-or-inline-attachment-capability'],
  ['bad upload schema', (h: any) => { delete h.tools[0].inputSchema.properties.attachments.items.properties.data; }, 'missing-inline-attachment-schema'],
  ['private-only schema', (h: any) => { h.tools[0].inputSchema.properties.type.enum = ['private']; }, 'unsupported-explicit-stream-schema'],
  ['inspection throws', (h: any) => { h.inspectThrows = true; }, 'backend-inspection-failed'],
] as const) test(`definitive PRE-DISPATCH refusal: ${label}; never falls back`, async () => {
  const h = await harness({ setup });
  expect(h.calls).toHaveLength(0);
  expect((await journal(h.dir)).records[0].outcome).toEqual({ state: 'not-dispatched', detail: reason });
  expect(h.module.homeState()?.deliveryHalted).toBe(false);
  h.state.servers = [{ id: 'latest-inbound', connected: true, toolPrefix: 'other' }];
  h.alert('future'); await h.settle();
  expect(h.calls).toHaveLength(0);
});

for (const [label, result] of [
  ['malformed response', async () => ({ success: true, data: 'not a Zulip acknowledgement' })],
  ['invalid message id', async () => ({ success: true, structured: { result: 'success', id: -1 } })],
  ['backend failure', async () => ({ success: false, error: 'DO-NOT-CAPTURE-RAW-BACKEND' })],
  ['transport throw', async () => { throw new Error('DO-NOT-CAPTURE-RAW-EXCEPTION'); }],
  ['timeout', async () => new Promise<never>(() => {})],
] as const) test(`ambiguous dispatch: ${label}; durable uncertainty and no replay`, async () => {
  const h = await harness();
  h.state.result = result;
  h.alert('future', 'once', 501); await h.settle();
  expect(h.calls).toHaveLength(2); // startup then one incident; its status stays local.
  const j = await journal(h.dir);
  expect(j.records.find((r: any) => r.kind === 'future').outcome.state).toBe('uncertain');
  expect(JSON.stringify(j)).not.toContain('DO-NOT-CAPTURE');
  await h.module.stop();
  const r = await harness({ dir: h.dir, instance: 'instance-B' });
  r.alert('future', 'once', 501); await r.settle();
  expect(r.calls).toHaveLength(1); // Independent startup; old uncertain record not resent.
});

test('late acknowledgement after timeout never upgrades uncertainty or triggers resend', async () => {
  const h = await harness();
  let finish!: (r: ToolResult) => void;
  h.state.result = () => new Promise((resolve) => { finish = resolve; });
  h.alert('future', 'late send', 550); await h.settle();
  finish({ success: true, structured: { result: 'success', id: 99 } });
  await new Promise((r) => setTimeout(r, 0));
  expect((await journal(h.dir)).records.find((r: any) => r.kind === 'future').outcome.state).toBe('uncertain');
  expect(h.calls).toHaveLength(2);
});

test('destination/logical-agent drift and corrupt journal refuse without overwriting evidence', async () => {
  const h = await harness(); await h.module.stop();
  const before = await readFile(join(h.dir, 'journal.json'), 'utf8');
  for (const change of [{ stream: 'elsewhere' }, { declaredRealm: 'https://elsewhere.invalid' }, { logicalAgent: 'another-agent' }, { statusTopic: 'elsewhere' }]) {
    const r = await harness({ dir: h.dir, config: { ...binding(), ...change }, instance: 'instance-B' });
    expect(r.calls).toHaveLength(0);
    expect(r.module.homeState()?.disabled).not.toBeNull();
    expect(await readFile(join(h.dir, 'journal.json'), 'utf8')).toBe(before);
    await r.module.stop();
  }
  await writeFile(join(h.dir, 'journal.json'), '{corrupt');
  const r = await harness({ dir: h.dir });
  expect(r.calls).toHaveLength(0);
  expect(await readFile(join(h.dir, 'journal.json'), 'utf8')).toBe('{corrupt');
});

test('non-private and oversized journals fail closed without replacing retained state', async () => {
  const h = await harness(); await h.module.stop();
  const before = await readFile(join(h.dir, 'journal.json'), 'utf8');
  await chmod(join(h.dir, 'journal.json'), 0o644);
  const notPrivate = await harness({ dir: h.dir });
  expect(notPrivate.calls).toHaveLength(0);
  expect(notPrivate.module.homeState()?.disabled).not.toBeNull();
  expect(await readFile(join(h.dir, 'journal.json'), 'utf8')).toBe(before);
  await notPrivate.module.stop();
  await chmod(join(h.dir, 'journal.json'), 0o600);
  const oversized = ' '.repeat(2 * 1024 * 1024 + 1);
  await writeFile(join(h.dir, 'journal.json'), oversized);
  const tooLarge = await harness({ dir: h.dir });
  expect(tooLarge.calls).toHaveLength(0);
  expect(tooLarge.module.homeState()?.disabled).not.toBeNull();
  expect((await stat(join(h.dir, 'journal.json'))).size).toBe(oversized.length);
});

test('missing current runtime instance is refused rather than anonymous delivery', async () => {
  const dir = await scratch();
  const module = new NoticesModule({ agentName: 'worker', home: binding(), homeRuntime: { directory: dir, instanceId: '' } });
  running.push(module);
  await expect(module.start({} as ModuleContext)).rejects.toThrow(/runtime instance identity/);
  expect(await readdir(dir)).toEqual([]);
});

test('binding is immutable during runtime, not taken from alert/inbound fields', async () => {
  const h = await harness();
  h.config.stream = 'attempted-mutation'; h.config.incidentsTopic = 'wrong';
  h.alert('future', 'event', 601, { serverId: 'wrong', stream: 'wrong', topic: 'wrong', realm: 'https://wrong.invalid' });
  await h.settle();
  expect(h.calls.every((c) => (c.input as any).to === 'private-ops')).toBe(true);
  expect(h.calls.some((c) => (c.input as any).topic === 'agent incidents')).toBe(true);
});

test('publication-caused alerts cannot recursively send; core processing continues without model callback', async () => {
  const h = await harness();
  h.state.result = async () => { h.alert('mcpl-down', 'diagnostic about the failed send', 702); return { success: false }; };
  h.alert('future', 'original', 701); await h.settle(); await h.settle();
  expect(h.calls).toHaveLength(2);
  expect((await journal(h.dir)).records.some((r: any) => r.kind === 'mcpl-down')).toBe(true);
  expect(await h.module.onProcess({ type: 'mcpl:channel-incoming', channelId: 'normal' } as never, {} as never)).toEqual({});
  expect(h.forbidden).toEqual([]);
  expect(h.module.homeState()?.deliveryHalted).toBe(false);
});

test('protected unknown backlog saturates explicitly; no evidence loss, disk/queue growth or notice storm', async () => {
  const h = await harness();
  await h.module.stop();
  // A bounded synthetic unknown backlog. Terminal records are tested separately.
  const fixture = await journal(h.dir);
  fixture.records = Array.from({ length: 128 }, () => ({ ...fixture.records[0], id: randomUUID(), outcome: { state: 'uncertain', detail: 'unknown; never evict/replay' } }));
  await writeFile(join(h.dir, 'journal.json'), JSON.stringify(fixture));
  const r = await harness({ dir: h.dir, instance: 'instance-B' });
  r.alert('future', 'last retained incident', 800); await r.settle();
  expect(r.module.homeState()?.disabled).not.toBeNull();
  const j = await journal(h.dir);
  expect(j.records.length).toBeLessThanOrEqual(128);
  const bytes = (await stat(join(h.dir, 'journal.json'))).size;
  expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  const before = r.calls.length;
  for (let i = 0; i < 200; i++) r.alert('other', 'excess', 1000 + i);
  await r.settle();
  expect(r.calls).toHaveLength(before);
  expect((await stat(join(h.dir, 'journal.json'))).size).toBe(bytes);
  expect((await readdir(h.dir)).filter((name) => name.startsWith('journal'))).toEqual(['journal.json']);
});

test('bounded queue overflow disables visibly without blocking core or attempting sends', async () => {
  const h = await harness();
  for (let i = 0; i < 100; i++) h.alert('future', `burst ${i}`, 2000 + i);
  await h.settle();
  expect(h.module.homeState()?.disabled).toContain('bounded-queue-exhausted');
  expect(h.module.homeState()?.queued).toBe(0);
  expect(await h.module.onProcess({ type: 'normal:event' } as never, {} as never)).toEqual({});
});

test('real AF ModuleContext dispatch reaches offline fake API with zero model callbacks and unchanged core state', async () => {
  const dir = await scratch();
  let modelCalls = 0;
  const posts: ToolCall[] = [];
  const config = { ...binding(), toolPrefix: 'offline-zulip' };
  const module = new NoticesModule({ agentName: 'worker', home: config,
    homeRuntime: { directory: join(dir, 'delivery'), instanceId: 'actual-AF-synthetic-host' } });
  const offlineApi: Module = {
    name: 'offline-zulip', async start() {}, async stop() {},
    getTools: () => [{ name: 'send_message', description: 'offline fake API, no transport', inputSchema: schema() }],
    async handleToolCall(call) {
      posts.push(call);
      const j = await journal(join(dir, 'delivery'));
      expect(j.records.find((r: any) => `notice-home-${r.id}` === call.id).outcome.state).toBe('intent');
      return { success: true, structured: { result: 'success', id: posts.length } };
    },
    async onProcess() { return {}; },
  };
  const framework = await AgentFramework.create({ storePath: join(dir, 'store'),
    membrane: new Membrane(new MockAdapter({ responseGenerator: () => { modelCalls++; throw new Error('model callback forbidden'); } })),
    agents: [{ name: 'worker', model: 'mock', systemPrompt: 'synthetic only', maxTokens: 64, allowedTools: [] }],
    modules: [module, offlineApi],
  });
  // Only discovery is faked. ModuleContext.callTool and AF module dispatch are
  // real. This test does NOT prove a connector's wire/realm/self-echo behavior.
  framework.listMcplServers = (() => [{ id: config.serverId, connected: true, toolPrefix: config.toolPrefix,
    toolClasses: [{ tool: `${config.toolPrefix}--send_message`, serverTool: 'send_message' }] }]) as typeof framework.listMcplServers;
  let inject: ((event: TraceEvent) => void) | undefined;
  const subscribe = framework.onTrace.bind(framework);
  framework.onTrace = (listener, options) => { inject = listener; return subscribe(listener, options); };
  try {
    const before = structuredClone(framework.healthSnapshot());
    const beforeChannels = framework.channels?.listChannelsRaw() ?? [];
    const beforeLocus = framework.channels?.incomingFor('worker') ?? null;
    module.setFramework(framework);
    await module.homeSettled();
    // Avoid notifyOps' optional external webhook and cwd failures.log sinks.
    inject!({ type: 'ops:alert', kind: 'future-kind', agentName: 'worker', message: 'synthetic public diagnostic', timestamp: 1000 });
    await module.homeSettled();
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(modelCalls).toBe(0);
    expect(framework.getAgent('worker')!.state.status).toBe('idle');
    expect(framework.channels?.listChannelsRaw() ?? []).toEqual(beforeChannels);
    expect(framework.channels?.incomingFor('worker') ?? null).toEqual(beforeLocus);
    const after = framework.healthSnapshot();
    expect((after.agents as any[])[0].providerAdmission).toEqual((before.agents as any[])[0].providerAdmission);
    expect((after.agents as any[])[0].lastInference).toEqual((before.agents as any[])[0].lastInference);
    expect((await journal(join(dir, 'delivery'))).records.every((r: any) => r.outcome.state === 'sent')).toBe(true);
  } finally { await framework.stop(); }
});

// fix1 regressions: AF 0.33 source order, and pinned fork contracts (see fixtures).
test('fix1 F2: startup connecting, actual mcpl-down/reconnect, new incident and restart do not latch', async () => {
  const h = await harness({ setup: h => { h.servers[0].connected = false; } });
  h.emit({ type: 'ops:alert', kind: 'mcpl-down', agentName: 'chat-ops', timestamp: 110, message: 'MCP server unreachable (attempt 1)' });
  await h.settle();
  const old = (await journal(h.dir)).records.map((r: any) => r.id);
  h.state.servers[0].connected = true;
  h.emit({ type: 'mcpl:server-reconnected', serverId: 'chat-ops', timestamp: 111 }); await h.settle();
  h.alert('independent', 'new incident', 112); await h.settle();
  expect(h.calls.some(c => (c.input as any).content.includes('new incident'))).toBe(true);
  expect((await journal(h.dir)).records.filter((r: any) => old.includes(r.id)).every((r: any) => r.outcome.state === 'not-dispatched')).toBe(true);
  await h.module.stop();
  const r = await harness({ dir: h.dir, instance: 'recovered' });
  r.alert('another-independent', 'after restart', 113); await r.settle();
  expect(r.calls.some(c => (c.input as any).content.includes('after restart'))).toBe(true);
  expect(r.calls.every(c => !old.includes(c.id.replace('notice-home-', '')))).toBe(true);
});

test('fix1 F3/F4: exact AF refusal streak order never clears; successful endTurn clears main refusal only', async () => {
  const h = await harness();
  h.alert('context-maintenance-failed', 'strategy init failed', 120, { data: { scope: 'agent', pending: 'compression' } });
  h.alert('refusal-offpath', 'background refused', 121);
  for (let streak = 2; streak <= 4; streak++) {
    // AF completeTurn emits completed before noteRefusal; completed carries NO stopReason.
    h.trace('inference:completed');
    h.alert('refusal', `refusal streak ${streak}, category=cyber`, 122 + streak, { data: { category: 'cyber', streak } });
    await h.settle();
  }
  let j = await journal(h.dir);
  expect(j.records.filter((r: any) => r.phase === 'recovery-observed')).toHaveLength(0);
  expect(new Set(j.records.filter((r: any) => r.kind === 'refusal').map((r: any) => r.incidentId)).size).toBe(1);
  h.trace('inference:failed'); h.trace('inference:aborted'); await h.settle();
  expect((await journal(h.dir)).active).toHaveLength(3);
  h.trace('inference:turn_ended'); await h.settle();
  j = await journal(h.dir);
  expect(j.active.map((a: any) => a.kind)).toEqual(['context-maintenance-failed', 'refusal-offpath']);
  expect(j.records.find((r: any) => r.kind === 'refusal-clear').source.type).toBe('inference:turn_ended');
  h.alert('context-maintenance-failed-clear', 'specific source clear', 140); await h.settle();
  expect((await journal(h.dir)).active.map((a: any) => a.kind)).toEqual(['refusal-offpath']);
});

test('fix1 F5: >128 healthy reconnect notices compact; uncertain/pending and active identity survive restart', async () => {
  const h = await harness();
  h.state.result = async () => ({ success: false });
  h.alert('unknown-delivery', 'never replay', 150); await h.settle();
  const uncertain = (await journal(h.dir)).records.find((r: any) => r.kind === 'unknown-delivery');
  h.state.result = async () => ({ success: true, structured: { result: 'success', id: h.calls.length } });
  for (let i = 0; i < 70; i++) {
    h.emit({ type: 'ops:alert', kind: 'mcpl-down', agentName: 'chat-ops', timestamp: 200 + i * 2, message: `MCP server unreachable (attempt ${i})` }); await h.settle();
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'chat-ops', timestamp: 201 + i * 2 }); await h.settle();
  }
  h.alert('fresh', 'fresh after compaction', 400); await h.settle();
  expect(h.module.homeState()?.disabled).toBeNull();
  expect(h.calls.length).toBeGreaterThan(128);
  expect(h.calls.some(c => (c.input as any).content.includes('fresh after compaction'))).toBe(true);
  let j = await journal(h.dir);
  expect(j.records.length).toBeLessThanOrEqual(128);
  expect(j.retention.evicted).toBeGreaterThan(0);
  expect(j.records.find((r: any) => r.kind === 'fresh').outcome.state).toBe('sent');
  console.log('fix1 bounded-retention witness', JSON.stringify({ calls: h.calls.length, retained: j.records.length, evicted: j.retention.evicted, bytes: (await stat(join(h.dir, 'journal.json'))).size }));
  expect(j.records.find((r: any) => r.id === uncertain.id).outcome.state).toBe('uncertain');
  expect((await stat(join(h.dir, 'journal.json'))).size).toBeLessThan(2 * 1024 * 1024);
  await h.module.stop();
  j.records.find((r: any) => r.id === uncertain.id).outcome = { state: 'intent' };
  await writeFile(join(h.dir, 'journal.json'), JSON.stringify(j));
  const r = await harness({ dir: h.dir, instance: 'compacted-restart' });
  r.alert('unknown-delivery', 'never replay', 150); await r.settle();
  expect(r.calls.some(c => c.id === `notice-home-${uncertain.id}`)).toBe(false);
  j = await journal(h.dir);
  expect(j.records.find((r: any) => r.id === uncertain.id).outcome.state).toBe('uncertain');
  expect(j.active.find((a: any) => a.kind === 'unknown-delivery').id).toBe(uncertain.incidentId);
  expect(r.module.homeState()?.disabled).toBeNull();
}, 30000);

test('fix1 F7: safe structured ops metadata retained, bounded and redacted, arbitrary bodies omitted honestly', async () => {
  const h = await harness();
  h.alert('store-held-lost', 'writes lost', 500, { data: { count: 4, kinds: { mail: 2, message: 2 }, mail: 2,
    keptForRecovery: 3, heldBySurgery: 1, request: 'PRIVATE-BODY', headers: { authorization: 'PRIVATE-HEADER' } } });
  h.alert('refusal', 'refused', 501, { data: { category: 'secret=DO-NOT-KEEP', streak: 3 } });
  h.alert('context-maintenance-failed', 'failed', 502, { data: { scope: 'agent', pending: 'api_key=HIDE', progress: { totalChunks: 2, pending: true, request: 'PRIVATE-PROGRESS' } } });
  await h.settle();
  const j = await journal(h.dir);
  expect(j.records.find((r: any) => r.kind === 'store-held-lost').metadata.fields).toMatchObject({ count: 4, kinds: { mail: 2, message: 2 }, mail: 2 });
  expect(j.records.find((r: any) => r.kind === 'refusal').metadata.fields).toEqual({ category: 'secret=(redacted)', streak: 3 });
  expect(j.records.find((r: any) => r.kind === 'context-maintenance-failed').metadata.fields).toMatchObject({ scope: 'agent', pending: 'api_key=(redacted)', progress: { totalChunks: 2, pending: true } });
  const serialized = JSON.stringify(j);
  for (const s of ['PRIVATE-BODY', 'PRIVATE-HEADER', 'PRIVATE-PROGRESS', 'DO-NOT-KEEP', 'HIDE']) expect(serialized).not.toContain(s);
  expect(serialized).toContain('omitted');
  expect(h.calls.some(c => (c.input as any).content.includes('diagnostic projection'))).toBe(true);
});


test('fix1 F1: actual fork nullable explicit stream schema dispatches; later schema refusal recovers', async () => {
  const h = await harness({ setup: h => { h.tools[0].inputSchema = forkSchema(); } });
  expect(h.calls).toHaveLength(1);
  expect((h.calls[0]!.input as any).reply_to).toBeUndefined();
  h.state.tools[0].inputSchema.properties.type = { type: ['null'] };
  h.alert('schema-refused', 'no post', 610); await h.settle();
  const refused = (await journal(h.dir)).records.find((r: any) => r.kind === 'schema-refused');
  expect(refused.outcome.state).toBe('not-dispatched');
  h.state.tools[0].inputSchema = forkSchema();
  h.alert('schema-recovered', 'new safe post', 611); await h.settle();
  expect(h.calls.some(c => (c.input as any).content.includes('new safe post'))).toBe(true);
  expect(h.calls.some(c => c.id === `notice-home-${refused.id}`)).toBe(false);
});

test('fix1 F1: null-only, invalid type arrays and conflicting enum/const never dispatch', async () => {
  for (const [field, property] of [
    ['type', { type: ['null'], enum: ['stream'] }], ['type', { type: ['string', 'object'] }],
    ['to', { type: 'string', enum: ['other-stream'] }], ['topic', { type: ['string', 'null'], const: 'other-topic' }],
    ['type', { type: 'string', enum: 'stream' }], ['content', { type: 'string', const: '' }],
    ['topic', { type: 'string', not: { const: 'agent status' } }],
  ] as const) {
    const h = await harness({ setup: h => { h.tools[0].inputSchema = forkSchema(); h.tools[0].inputSchema.properties[field] = property; } });
    expect(h.calls).toHaveLength(0);
    expect((await journal(h.dir)).records[0].outcome.state).toBe('not-dispatched');
  }
});

test('fix1 F1b: fork legacy/compat/strict receipts retain opaque server-scoped IDs across restart', async () => {
  for (const ids of [[42, 43], ['realm:42', 'realm:43'], ['other-realm_2:42', 'other-realm_2:43']]) {
    const h = await harness({ setup: h => { h.result = async () => ({ success: true, structured: {
      result: 'success', id: ids[0], ids, type: 'stream', stream: 'private-ops', topic: 'agent status', channelId: 'zulip:private-ops',
    } }); } });
    let j = await journal(h.dir);
    expect(j.records[0].outcome).toEqual({ state: 'sent', messageIds: ids, serverId: 'chat-ops' });
    await h.module.stop();
    const r = await harness({ dir: h.dir, instance: 'receipt-restart' });
    j = await journal(h.dir);
    expect(j.records[0].outcome.messageIds).toEqual(ids);
    expect(r.module.homeState()?.disabled).toBeNull();
  }
});

test('fix1 F1b: malformed/failure/mismatched receipts remain uncertain, never upgraded on restart', async () => {
  for (const raw of [
    { result: 'success', id: 'realm:0' }, { result: 'success', id: 'realm:9007199254740992' },
    { result: 'success', id: 'Realm:42' }, { result: 'success', id: 'realm:42junk' },
    { result: 'success', id: 'realm:1e2' }, { result: 'success', id: 'realm:42', ids: ['other:42'] },
    { result: 'success', id: 'realm:42', ids: ['realm:42', 'other:43'] },
    { result: 'success', id: 'realm:42', realm: 'https://elsewhere.invalid' },
    { result: 'success', id: 'realm:42', topic: 'wrong-topic' },
    { result: 'success', id: 'realm:42', stream: 'wrong-stream' },
    { result: 'success', id: 'realm:42', type: 'private' },
    { result: 'success', id: 'realm:42', serverId: 'other-server' },
    { result: 'success', id: 'realm:42', channelId: 'zulip:elsewhere' },
    { result: 'success', id: 'realm:42', ids: [] }, { result: 'success' },
  ]) {
    const h = await harness({ setup: h => { h.result = async () => ({ success: true, structured: raw }); } });
    expect((await journal(h.dir)).records[0].outcome.state).toBe('uncertain');
  }
  const h = await harness({ setup: h => { h.result = async () => ({ success: false, structured: { result: 'success', id: 'realm:42' } }); } });
  let j = await journal(h.dir); const old = j.records[0];
  expect(old.outcome.state).toBe('uncertain');
  j.deliveryHalted = true; // Original v1 circuit evidence is retained, not a future-message latch.
  await h.module.stop(); await writeFile(join(h.dir, 'journal.json'), JSON.stringify(j));
  const r = await harness({ dir: h.dir, instance: 'old-uncertainty' });
  j = await journal(h.dir);
  expect(j.records[0].outcome).toEqual(old.outcome);
  expect(j.deliveryHalted).toBe(true);
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0]!.id).not.toBe(`notice-home-${old.id}`);
});

test('fix1 F6: fork macro contract displays literal tokens in/outside fences, even >20 and unreadable', async () => {
  const h = await harness();
  const quoted = '``` [[msg:999999]] ``` @**all** ' + '[[msg:realm:42]] '.repeat(24);
  h.alert('quoted-diagnostic', quoted, 650); await h.settle();
  const content = (h.calls.find(c => (c.input as any).topic === 'agent incidents')!.input as any).content;
  for (const mode of ['legacy', 'compat', 'strict'] as const) {
    const displayed = literalForkDisplay(content, mode);
    expect(displayed).toContain('[[msg:999999]]');
    expect(displayed).toContain('[[msg:realm:42]]');
    expect(displayed).not.toContain('@**all**');
    expect(displayed).not.toContain('``` [[msg:');
  }
  expect(content).toContain('diagnostic projection');
});

test('fix1 minor: idle/primaryActive trace-time conflict is honestly unknown, not a stale current-active claim', async () => {
  const h = await harness({ setup: h => { h.primaryActive = true; } });
  const r = (await journal(h.dir)).records[0];
  const snapshot = JSON.parse(r.diagnostic);
  expect(snapshot.providerAdmission.primaryActive).toBeNull();
  expect(snapshot.providerAdmissionSample).toBe('transition-unsettled');
  expect(r.observedAt).toBe(100);
  expect(r.source.timestamp).toBe(100);
});

test('fix1 F7: structured bounds/disposition and changed metadata dedup are durable', async () => {
  const h = await harness();
  const kinds = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`kind-${i}` + 'x'.repeat(200), i]));
  h.alert('structured', 'same message', 700, { data: { kinds, category: 'x'.repeat(1000), scope: 'agent', pending: 'p'.repeat(1000), env: 'PRIVATE-ENV' } }); await h.settle();
  const first = (await journal(h.dir)).records.find((r: any) => r.kind === 'structured');
  expect(first.metadata.truncated).toBe(true);
  expect(first.metadata.omitted).toBeGreaterThan(0);
  expect(JSON.stringify(first.metadata).length).toBeLessThanOrEqual(4096);
  h.alert('structured', 'same message', 701, { data: { count: 2 } }); await h.settle();
  expect((await journal(h.dir)).records.filter((r: any) => r.kind === 'structured')).toHaveLength(2);
  await h.module.stop();
  const r = await harness({ dir: h.dir, instance: 'metadata-restart' });
  expect(r.module.homeState()?.disabled).toBeNull();
  expect((await journal(h.dir)).records.find((x: any) => x.id === first.id).metadata).toEqual(first.metadata);
});

test('fix1 F1: root constraints, required fallback, and inline attachment constraints refuse locally', async () => {
  for (const setup of [
    (s: any) => { s.allOf = [{ not: {} }]; },
    (s: any) => { s.required = ['reply_to']; },
    (s: any) => { s.properties.attachments.maxItems = 0; },
    (s: any) => { s.properties.attachments.items.required = ['file']; },
    (s: any) => { s.properties.attachments.items.properties.mime_type.const = 'text/plain'; },
  ]) {
    const h = await harness({ setup: h => { h.tools[0].inputSchema = forkSchema(); setup(h.tools[0].inputSchema); } });
    expect(h.calls).toHaveLength(0);
    expect((await journal(h.dir)).records[0].outcome.state).toBe('not-dispatched');
  }
});

test('fix1 F1b: actual single JSON content branded acknowledgement and corrupt receipt scope validation', async () => {
  const h = await harness({ setup: h => { h.tools[0].inputSchema = forkSchema(); h.result = async () => ({ success: true,
    data: [{ type: 'text', text: JSON.stringify({ result: 'success', id: 'realm:42', ids: ['realm:42', 'realm:43'] }) }],
  }); } });
  let j = await journal(h.dir);
  expect(j.records[0].outcome).toEqual({ state: 'sent', messageIds: ['realm:42', 'realm:43'], serverId: 'chat-ops' });
  await h.module.stop();
  j.records[0].outcome.serverId = 'wrong-server';
  const corrupt = JSON.stringify(j); await writeFile(join(h.dir, 'journal.json'), corrupt);
  const r = await harness({ dir: h.dir, instance: 'corrupt-receipt' });
  expect(r.calls).toHaveLength(0);
  expect(r.module.homeState()?.disabled).not.toBeNull();
  expect(await readFile(join(h.dir, 'journal.json'), 'utf8')).toBe(corrupt);
});

test('fix1 F2: delayed publication failure after timeout cannot recurse; new independent incident still delivers', async () => {
  const h = await harness();
  let attempts = 0;
  h.state.result = async () => {
    if (++attempts === 1) {
      await new Promise(resolve => setTimeout(resolve, 65));
      h.alert('mcpl-down', 'late failure of our own timed-out send', 810, { agentName: 'chat-ops' });
    }
    return { success: false };
  };
  h.alert('original-timeout', 'original independent incident', 800); await h.settle();
  await new Promise(resolve => setTimeout(resolve, 90)); await h.settle();
  expect(h.calls).toHaveLength(2); // startup and original only, never the late child alert/status.
  let j = await journal(h.dir);
  expect(j.records.find((r: any) => r.kind === 'original-timeout').outcome.state).toBe('uncertain');
  expect(j.records.find((r: any) => r.kind === 'mcpl-down').outcome.state).toBe('not-dispatched');
  h.state.result = async () => ({ success: true, structured: { result: 'success', id: h.calls.length } });
  h.emit({ type: 'mcpl:server-reconnected', serverId: 'chat-ops', timestamp: 811 }); await h.settle();
  h.alert('new-independent', 'new independent incident after recovery', 812); await h.settle();
  j = await journal(h.dir);
  expect(j.records.find((r: any) => r.kind === 'new-independent').outcome.state).toBe('sent');
  expect(j.records.find((r: any) => r.kind === 'original-timeout').outcome.state).toBe('uncertain');
});


for (const [first, ownCallbacks] of [['status', false], ['incident', false], ['incident', true]] as const) {
  test(`fix2 N1: slow successful ${first} send queues outside-context burst; own callbacks=${ownCallbacks}`, async () => {
    const h = await harness({ sendTimeoutMs: 1000 });
    let entered!: () => void, release!: () => void, releaseLate!: () => void, lateDone!: () => void;
    const inFlight = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lateGate = new Promise<void>(resolve => { releaseLate = resolve; });
    const lateFinished = new Promise<void>(resolve => { lateDone = resolve; });
    let attempts = 0;
    h.state.result = async () => {
      const messageId = h.calls.length;
      if (++attempts === 1) {
        if (ownCallbacks) {
          h.alert('mcpl-down', 'own synchronous failure callback', 901, { agentName: 'chat-ops' });
          // The continuation is created INSIDE callTool's publication context,
          // but fires after the successful send and independent burst settle.
          void (async () => {
            await lateGate;
            h.alert('mcpl-down', 'own late failure callback', 904, { agentName: 'chat-ops' });
            lateDone();
          })();
        }
        entered();
        await gate;
      }
      return { success: true, structured: { result: 'success', id: messageId } };
    };
    if (first === 'status') {
      h.state.status = 'inferring'; h.trace('inference:started');
    } else h.alert('mcpl-down', 'other server unavailable', 900, { agentName: 'other-server' });
    await inFlight;
    // This test continuation is OUTSIDE callTool's ALS context. Both source
    // observations arrive while the unrelated successful send is held open.
    try {
      expect(h.calls).toHaveLength(2);
      h.alert('hard-down', 'independent provider unavailable', 902);
      h.alert('store-held-lost', 'independent held mail lost', 903, { data: { count: 2 } });
      expect(h.module.homeState()?.queued).toBeGreaterThanOrEqual(3);
    } finally { release(); }
    await h.settle(); await h.settle();
    releaseLate();
    if (ownCallbacks) await lateFinished;
    await h.settle(); await h.settle();
    const j = await journal(h.dir);
    const external = j.records.filter((r: any) => r.phase === 'incident' && r.subject !== 'chat-ops');
    expect(external.map((r: any) => r.kind)).toEqual(first === 'status'
      ? ['hard-down', 'store-held-lost'] : ['mcpl-down', 'hard-down', 'store-held-lost']);
    for (const r of external) {
      expect(r.outcome.state).toBe('sent');
      expect(h.calls.filter(c => c.id === `notice-home-${r.id}`)).toHaveLength(1);
    }
    // Their derived statuses are delivered, not silently made local-only.
    for (const kind of ['hard-down', 'store-held-lost']) {
      expect(j.records.some((r: any) => r.phase === 'status' && r.outcome.state === 'sent' && r.diagnostic.includes(kind))).toBe(true);
    }
    const own = j.records.filter((r: any) => r.phase === 'incident' && r.subject === 'chat-ops');
    expect(own).toHaveLength(ownCallbacks ? 2 : 0);
    for (const r of own) {
      expect(r.outcome).toEqual({ state: 'not-dispatched', detail: 'publication-related-observation; no recursive delivery' });
      expect(h.calls.some(c => c.id === `notice-home-${r.id}`)).toBe(false);
    }
    // startup + slow send (+ incident's status) + two incidents and statuses;
    // neither own callback nor its derived status starts another send.
    expect(h.calls).toHaveLength(first === 'status' ? 6 : 7);
    expect(h.module.homeState()).toMatchObject({ disabled: null, queued: 0 });
    expect(h.forbidden).toEqual([]);
  });
}

test('fix2 N2: fresh identical observation after server recovery sends once; no old/uncertain replay', async () => {
  const h = await harness();
  h.state.result = async () => ({ success: false });
  h.alert('refusal-offpath', 'unknown remote outcome', 910); await h.settle();
  const uncertain = (await journal(h.dir)).records.find((r: any) => r.kind === 'refusal-offpath');
  expect(uncertain.outcome.state).toBe('uncertain');
  h.state.result = async () => ({ success: true, structured: { result: 'success', id: h.calls.length } });
  h.state.servers[0].connected = false;
  h.alert('hard-down', 'same provider diagnostic', 911, { traceId: 'first-source' }); await h.settle();
  const original = (await journal(h.dir)).records.find((r: any) => r.kind === 'hard-down');
  expect(original.outcome).toEqual({ state: 'not-dispatched', detail: 'bound-server-unavailable' });
  const before = h.calls.length;
  h.state.servers[0].connected = true;
  h.emit({ type: 'mcpl:server-reconnected', serverId: 'chat-ops', timestamp: 912 }); await h.settle();
  // Neither recovery nor replay of the exact retained source retries a record.
  h.alert('hard-down', 'same provider diagnostic', 911, { traceId: 'first-source' }); await h.settle();
  h.alert('refusal-offpath', 'unknown remote outcome', 910); await h.settle();
  h.alert('refusal-offpath', 'unknown remote outcome', 913); await h.settle();
  expect(h.calls).toHaveLength(before);
  expect((await journal(h.dir)).records.find((r: any) => r.id === uncertain.id)).toMatchObject({ count: 2, outcome: uncertain.outcome });
  h.alert('hard-down', 'same provider diagnostic', 914, { traceId: 'fresh-source' }); await h.settle();
  let j = await journal(h.dir);
  const incidents = j.records.filter((r: any) => r.kind === 'hard-down');
  expect(incidents).toHaveLength(2);
  expect(incidents[0]).toEqual(original); // first source/outcome/evidence untouched
  const fresh = incidents[1];
  expect(fresh).toMatchObject({ incidentId: original.incidentId, count: 1,
    source: { timestamp: 914, traceId: 'fresh-source' }, outcome: { state: 'sent' } });
  expect(fresh.id).not.toBe(original.id);
  expect(h.calls).toHaveLength(before + 1);
  expect(h.calls.filter(c => c.id === `notice-home-${fresh.id}`)).toHaveLength(1);
  // Delivered-anchor coalescing stays unchanged; exact first source still dedups.
  h.alert('hard-down', 'same provider diagnostic', 915, { traceId: 'next-source' }); await h.settle();
  h.alert('hard-down', 'same provider diagnostic', 911, { traceId: 'first-source' }); await h.settle();
  expect(h.calls).toHaveLength(before + 1);
  expect((await journal(h.dir)).records.find((r: any) => r.id === fresh.id)).toMatchObject({ count: 2, lastSource: { timestamp: 915 } });
  h.trace('inference:turn_ended'); await h.settle();
  j = await journal(h.dir);
  const clear = j.records.find((r: any) => r.kind === 'hard-down-clear');
  expect(clear).toMatchObject({ incidentId: original.incidentId, phase: 'recovery-observed',
    source: { type: 'inference:turn_ended' }, outcome: { state: 'sent' } });
  expect(h.calls.filter(c => c.id === `notice-home-${clear.id}`)).toHaveLength(1);
  expect(j.active.map((a: any) => a.kind)).toEqual(['refusal-offpath']);
  expect(j.records.find((r: any) => r.id === original.id)).toEqual(original);
  expect(j.records.find((r: any) => r.id === uncertain.id).outcome).toEqual(uncertain.outcome);
  expect(h.calls.some(c => c.id === `notice-home-${original.id}`)).toBe(false);
  expect(h.calls.filter(c => c.id === `notice-home-${uncertain.id}`)).toHaveLength(1);
  expect(h.forbidden).toEqual([]);
});
