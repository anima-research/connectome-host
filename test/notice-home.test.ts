import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm, link, lstat, readlink, stat, readdir, symlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ModuleContext, ToolCall, ToolResult, TraceEvent, ToolDefinition } from '@animalabs/agent-framework';
import { AgentFramework, type Module } from '@animalabs/agent-framework';
import { Membrane, MockAdapter } from '@animalabs/membrane';
import { homeBindingKey, type NoticeHomeConfig } from '../src/notice-home-config.js';
import { NoticesModule } from '../src/modules/notices-module.js';
import { switchSessionSteps } from '../src/session-switch.js';
import { validateRecipe } from '../src/recipe.js';
import { forkSchema } from './fixtures/notice-home/fork-contract.js';

const binding = (): NoticeHomeConfig => ({ connector: 'zulip', logicalAgent: 'pilot', serverId: 'chat-ops',
  toolPrefix: 'mcpl--chat-ops', declaredRealm: 'https://example.invalid', stream: 'private-ops',
  statusTopic: 'agent status', incidentsTopic: 'agent incidents', trustMode: 'operator-attested-unverified', selfEchoPreflight: 'operator-attested' });
const schema = (): ToolDefinition['inputSchema'] => ({ type: 'object', properties: {
  type: { type: 'string', enum: ['stream', 'private'] }, to: { type: 'string' }, topic: { type: 'string' }, content: { type: 'string' },
  attachments: { type: 'array', items: { type: 'object', properties: { data: { type: 'string' }, name: { type: 'string' }, mime_type: { type: 'string' } } } },
} });
const dirs: string[] = [];
const running: NoticesModule[] = [];
const intentAtDispatch: Array<{ callId: string; state?: string }> = [];
const HELD_SEND_TIMEOUT_MS = 60_000; // Deadline shouldn't race an explicit test release.
afterEach(async () => {
  for (const m of running.splice(0)) await m.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  // Assert outside callTool, where adapter error handling could mask a failure
  // as the uncertain outcome that some tests are already expecting.
  for (const check of intentAtDispatch.splice(0)) expect(check).toMatchObject({ state: 'intent' });
});
async function scratch() { const d = await mkdtemp(join(tmpdir(), 'host-notice-home-')); dirs.push(d); return d; }
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const keyFor = (kind: string, subject = 'worker') => digest(JSON.stringify([kind, subject]));
const delivered = (calls: ToolCall[], record: { id: string }) => calls.some(c => c.id === `notice-home-${record.id}`);
const observed = (j: any, timestamp: number) => j.records.find((r: any) => r.phase !== 'status' && r.source.timestamp === timestamp);

async function journal(dir: string): Promise<any> { return JSON.parse(await readFile(join(dir, 'journal.json'), 'utf8')); }
/** Journals moved aside on startup: name -> exact bytes. */
async function movedAside(dir: string): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  for (const name of (await readdir(dir)).filter(n => n.startsWith('journal.archived-')).sort()) out[name] = await readFile(join(dir, name));
  return out;
}
async function harness(options: { dir?: string; config?: NoticeHomeConfig; instance?: string; agentName?: string; sendTimeoutMs?: number; setup?: (h: any) => void } = {}) {
  const dir = options.dir ?? await scratch();
  const config = options.config ?? binding();
  const agentName = options.agentName ?? 'worker';
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
    status: 'idle', primaryActive: false, healthReads: 0,
    result: async (_call: ToolCall): Promise<ToolResult> => ({ success: true, data: [{ type: 'text', text: JSON.stringify({ result: 'success', id: calls.length }) }] }),
    emit: (event: Record<string, unknown>) => listener(event),
    alert: (kind: string, message = 'diagnostic', timestamp = ++t, extra = {}) => listener({ type: 'ops:alert', kind, message, agentName: 'worker', timestamp, ...extra }),
    trace: (type: string) => listener({ type, agentName: 'worker', timestamp: ++t }),
    tick: () => ++t,
    inspectThrows: null as 'servers' | 'tools' | null,
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
      // Synchronous evidence read cannot race the fake acknowledgement's
      // timeout via an unrelated asynchronous filesystem completion.
      const check: typeof intentAtDispatch[number] = { callId: call.id };
      intentAtDispatch.push(check);
      const j = JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8'));
      check.state = j.records.find((r: any) => `notice-home-${r.id}` === call.id)?.outcome.state;
      return h.result(call);
    },
  } as unknown as ModuleContext;
  const makeFramework = () => ({
    onTrace: (fn: (event: any) => void, options?: { replay?: boolean }) => {
      listener = fn;
      if (options?.replay) for (const event of h.early) fn(event);
      return () => { listener = () => {}; };
    },
    listMcplServers: () => { if (h.inspectThrows === 'servers') throw new Error('PRIVATE-INSPECTION-ERROR'); return h.servers; },
    getAllTools: () => { if (h.inspectThrows === 'tools') throw new Error('PRIVATE-INSPECTION-ERROR'); return h.tools; },
    healthSnapshot: () => {
      h.healthReads++;
      return { at: t, agents: [{ name: agentName, status: h.status, providerAdmission: { primaryActive: h.primaryActive } }] };
    },
    getAgent: trap('getAgent/model'), requestInference: trap('framework.requestInference'),
    channels: { publishForAgent: trap('publishForAgent'), open: trap('channel_open'), setLocus: trap('setLocus') },
  });
  const module = new NoticesModule({ agentName, home: config, homeRuntime: {
    directory: dir, instanceId: options.instance ?? 'instance-A', sendTimeoutMs: options.sendTimeoutMs ?? 1000,
  }, now: () => t });
  running.push(module);
  const bindFramework = async () => {
    await module.start(ctx);
    const framework = makeFramework();
    module.setFramework(framework as never);
    return framework;
  };
  const framework = await bindFramework();
  await module.homeSettled();
  return { ...h, state: h, module, framework, bindFramework, settle: () => module.homeSettled() };
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

test('startup uses fixed tool/server/stream/topics with operator-attested, unverified realm; intent is durable; no LLM/locus/admission effects', async () => {
  const h = await harness();
  expect(h.calls).toHaveLength(1);
  const c = h.calls[0]!;
  expect(c.name).toBe('mcpl--chat-ops--send_message');
  expect(c.input).toMatchObject({ type: 'stream', to: 'private-ops', topic: 'agent status' });
  expect(c.input).not.toHaveProperty('reply_to');
  const j = await journal(h.dir);
  expect(j.bindingId).toBe(digest(homeBindingKey(binding())));
  const attachment = JSON.parse(Buffer.from((c.input as any).attachments[0].data, 'base64').toString());
  expect(attachment.verification).toBe('operator-attested/unverified');
  expect(attachment.selfEchoReadiness).toBe('operator-attested-preflight/not-runtime-verified');
  expect(j.records[0].outcome).toEqual({ state: 'sent', messageIds: [1] });
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

test('startup and incident changes report tracking only, with no health sampling or polling', async () => {
  const timeouts = spyOn(globalThis, 'setTimeout');
  const intervals = spyOn(globalThis, 'setInterval');
  const cleared = spyOn(globalThis, 'clearTimeout');
  try {
    const h = await harness();
    h.alert('novel-outage'); await h.settle();
    h.trace('inference:waiting'); h.trace('inference:completed'); h.trace('inference:turn_ended'); await h.settle();
    const j = await journal(h.dir);
    expect(h.state.healthReads).toBe(0);
    expect(j.active.map((a: any) => a.kind)).toEqual(['unknown-alert-kind']);
    const statuses = j.records.filter((r: any) => r.phase === 'status');
    expect(statuses.map((r: any) => r.source.type)).toEqual(['startup', 'ops:alert']);
    expect(statuses[0].tracking).toEqual({ activeIncidentIds: [], forgottenActive: 0 });
    expect(statuses[1].tracking).toEqual({ activeIncidentIds: [j.active[0].id], forgottenActive: 0 });
    expect(intervals).not.toHaveBeenCalled();
    // Every registered timer is a completed delivery deadline, not a dormant
    // polling callback beyond a short observation window.
    expect(timeouts.mock.calls.every(([, ms]) => ms === 1000)).toBe(true);
    expect(cleared.mock.calls).toHaveLength(timeouts.mock.calls.length);
  } finally { timeouts.mockRestore(); intervals.mockRestore(); cleared.mockRestore(); }
});

test('startup and bounded framework early ops replay are observations, not inferred health/recovery', async () => {
  const h = await harness({ setup: (h) => {
    h.early = [{ type: 'ops:alert', kind: 'mcpl-down', agentName: 'other-component', timestamp: 10, message: 'startup source diagnostic' }];
  } });
  const j = await journal(h.dir);
  expect(j.records[0]).toMatchObject({ kind: 'startup-observation', observedAt: 100, source: { type: 'startup', timestamp: 100 } });
  expect(j.records.find((r: any) => r.kind === 'mcpl-down')).toMatchObject({ incidentKey: keyFor('mcpl-down', 'other-component'), source: { timestamp: 10 } });
  expect(j.records.some((r: any) => r.phase === 'recovery-observed')).toBe(false);
});

test('omitting home makes no backend capability/health calls and creates no delivery journal', async () => {
  const dir = await scratch();
  const module = new NoticesModule({ agentName: 'worker', homeRuntime: { directory: dir, instanceId: 'legacy' } }); running.push(module);
  await module.start({} as ModuleContext);
  const forbidden = () => { throw new Error('legacy must not inspect home backend'); };
  module.setFramework({ onTrace: () => () => {}, listMcplServers: forbidden, getAllTools: forbidden, healthSnapshot: forbidden } as never);
  expect(module.homeState()).toBeNull();
  expect(await readdir(dir)).toEqual([]);
});

test('all observed alert kinds including refusal/unknown get generic incidents; explicit clear keeps incident ref', async () => {
  const h = await harness();
  h.alert('future-notice-kind', 'exact wording', 101);
  h.alert('refusal', 'streak 2 category unchanged', 102);
  h.alert('', 'malformed kind has honest fallback', 103);
  await h.settle();
  let j = await journal(h.dir);
  expect(j.records.filter((r: any) => r.phase === 'incident').map((r: any) => r.kind)).toEqual(['unknown-alert-kind', 'refusal', 'unknown-alert-kind']);
  const incident = observed(j, 101);
  h.alert('future-notice-kind-clear', 'explicit source clear', 104); await h.settle();
  j = await journal(h.dir);
  expect(observed(j, 104)).toMatchObject({ phase: 'recovery-observed', incidentId: incident.incidentId });
  h.trace('inference:turn_ended'); await h.settle();
  expect((await journal(h.dir)).active.map((a: any) => a.kind)).toEqual(['unknown-alert-kind']);
});

test('matching component reconnect or mcpl module-added clears mcpl-down, not unrelated events', async () => {
  const h = await harness();
  h.alert('mcpl-down', 'component unavailable', 150, { agentName: 'component-A' }); await h.settle();
  h.emit({ type: 'mcpl:server-reconnected', serverId: 'component-B', timestamp: 151 }); await h.settle();
  expect((await journal(h.dir)).active).toHaveLength(1);
  h.emit({ type: 'mcpl:server-reconnected', serverId: 'component-A', timestamp: 152 }); await h.settle();
  const j = await journal(h.dir);
  expect(j.active).toHaveLength(0);
  expect(observed(j, 152)).toMatchObject({
    phase: 'recovery-observed', kind: 'mcpl-down', incidentKey: keyFor('mcpl-down', 'component-A'), source: { type: 'mcpl:server-reconnected', timestamp: 152 },
  });
  expect(j.records.at(-1).tracking.activeIncidentIds).toEqual([]);
  h.alert('mcpl-down', 'new component episode', 153, { agentName: 'component-A' }); await h.settle();
  h.emit({ type: 'module:added', moduleName: 'component-A', timestamp: 154 }); await h.settle();
  expect((await journal(h.dir)).active).toHaveLength(1);
  h.emit({ type: 'module:added', moduleName: 'mcpl:component-A', timestamp: 155 }); await h.settle();
  expect((await journal(h.dir)).active).toHaveLength(0);
});

test('free-text inputs never appear in the journal, display or decoded attachments', async () => {
  const canary = 'NOTICE_PRIVACY_CANARY';
  const config: NoticeHomeConfig = {
    ...binding(), logicalAgent: canary, serverId: `server-${canary}`, toolPrefix: `mcpl--${canary}`,
    declaredRealm: `https://${canary.toLowerCase()}.invalid`, stream: `stream-${canary}`,
    statusTopic: `status-${canary}`, incidentsTopic: `incidents-${canary}`,
  };
  const h = await harness({ config, agentName: canary, instance: canary });
  const data = {
    category: canary, scope: canary, pending: canary, kinds: { [canary]: 2 },
    progress: { pending: canary, summaryCounts: { [canary]: 3 } }, [canary]: { nested: canary },
  };
  // An unknown kind (and its clear) and a known kind exercise both paths.
  h.alert(canary, canary, 201, { agentName: canary, traceId: canary, data });
  h.alert(`${canary}-clear`, canary, 202, { agentName: canary, traceId: canary, data });
  h.alert('hard-down', canary, 203, { agentName: canary, traceId: canary, data });
  h.emit({ type: 'inference:turn_ended', agentName: canary, traceId: canary, timestamp: 204 });
  h.alert('mcpl-down', canary, 205, { agentName: config.serverId, traceId: canary, data });
  h.emit({ type: 'mcpl:server-reconnected', serverId: config.serverId, traceId: canary, timestamp: 206 });
  h.alert('mcpl-down', canary, 207, { agentName: config.serverId, traceId: canary, data });
  h.emit({ type: 'module:added', moduleName: `mcpl:${config.serverId}`, traceId: canary, timestamp: 208 });
  h.emit({ type: canary, message: canary });
  await h.settle();
  h.state.result = async () => ({ success: false, error: canary, data: [{ type: 'text', text: canary }] });
  h.alert('provider-hold', canary, 209, { agentName: canary, traceId: canary, data });
  await h.settle();
  h.state.result = async () => { throw new Error(canary); };
  h.alert('auth-rejected', canary, 210, { agentName: canary, traceId: canary, data });
  await h.settle();

  const bytes = await readFile(join(h.dir, 'journal.json'), 'utf8');
  const payloads = h.calls.map(({ input }) => {
    const { content, attachments } = input as any;
    expect(attachments).toHaveLength(1);
    const [{ data, name }] = attachments;
    return { content, name, decoded: Buffer.from(data, 'base64').toString() };
  });
  expect(payloads.length).toBeGreaterThan(1);
  const sinks = [bytes, ...payloads.flatMap(({ content, name, decoded }) => [content, name, decoded])];
  expect(sinks.map(sink => sink.toLowerCase().includes(canary.toLowerCase()))).toEqual(sinks.map(() => false));
  const saved = JSON.parse(bytes);
  const fields = (o: object) => Object.keys(o).sort();
  expect(fields(saved)).toEqual('active bindingId currentInstance lastStatus records retention version'.split(' '));
  const records = saved.records;
  for (const record of records) {
    const expected = 'count eventKey id incidentId incidentKey instanceId kind lastEventKey lastSeen lastSource observedAt outcome phase source'.split(' ');
    if (record.phase === 'status') expected.push('tracking');
    expect(fields(record)).toEqual(expected.sort());
  }
  const incidents = records.filter((r: any) => r.phase !== 'status');
  expect(incidents.map((r: any) => [r.kind, r.phase, r.source.timestamp])).toEqual([
    ['unknown-alert-kind', 'incident', 201], ['unknown-alert-kind', 'recovery-observed', 202],
    ['hard-down', 'incident', 203], ['hard-down', 'recovery-observed', 204],
    ['mcpl-down', 'incident', 205], ['mcpl-down', 'recovery-observed', 206],
    ['mcpl-down', 'incident', 207], ['mcpl-down', 'recovery-observed', 208],
    ['provider-hold', 'incident', 209], ['auth-rejected', 'incident', 210],
  ]);
  expect(observed({ records }, 209).outcome.state).toBe('uncertain');
  expect(observed({ records }, 210).outcome.state).toBe('uncertain');
  expect(h.calls).toHaveLength(records.length - 2); // Only the two derived statuses stay local.
  for (const [i, call] of h.calls.entries()) {
    const input = call.input as any;
    expect(input.to).toBe(config.stream); // Routing still uses the original binding.
    const { decoded } = payloads[i]!;
    const attachment = JSON.parse(decoded);
    expect(fields(attachment)).toEqual(['record', 'selfEchoReadiness', 'verification']);
    const { record } = attachment;
    expect(call.id).toBe(`notice-home-${record.id}`);
    expect(input.content).toContain(record.id);
    expect(record).toEqual({ ...records.find((r: any) => r.id === record.id), outcome: { state: 'intent' } });
  }
});

test('review2 2: normal turns neither post statuses nor evict resolved incident evidence', async () => {
  const h = await harness();
  h.alert('hard-down', 'episode to retain'); await h.settle();
  h.trace('inference:turn_ended'); await h.settle(); // Explicit recovery, now unprotected.
  const path = join(h.dir, 'journal.json');
  const before = await readFile(path, 'utf8');
  expect(JSON.parse(before).records.some((r: any) => r.kind === 'hard-down' && r.phase === 'recovery-observed')).toBe(true);
  const calls = h.calls.length;
  for (let i = 0; i < 70; i++) {
    h.state.status = 'running'; h.state.primaryActive = true;
    h.trace('inference:started'); await h.settle();
    h.state.status = 'idle'; h.state.primaryActive = false;
    h.trace('inference:completed'); h.trace('inference:turn_ended'); await h.settle();
  }
  const digest = (s: string) => createHash('sha256').update(s).digest('hex');
  expect(digest(await readFile(path, 'utf8'))).toBe(digest(before));
  expect(h.calls).toHaveLength(calls);
}, 30000);

test('restart preserves the previous journal and loses correlation with its incidents', async () => {
  const h = await harness();
  const path = join(h.dir, 'journal.json');
  h.alert('hard-down', 'first observation', 630);
  await h.settle(); await h.module.stop();
  const previous = await readFile(path);
  const priorId = observed(JSON.parse(previous.toString()), 630).incidentId;

  const r = await harness({ dir: h.dir, instance: 'next-run' });
  expect(Object.values(await movedAside(h.dir))).toEqual([previous]);
  expect(r.calls).toHaveLength(1); // New startup status, not old incidents.
  const fresh = await journal(h.dir);
  expect(fresh.active).toEqual([]);
  expect(fresh.retention).toEqual({ evicted: 0, forgottenActive: 0 });
  expect(fresh.records).toEqual([expect.objectContaining({
    kind: 'startup-observation', tracking: { activeIncidentIds: [], forgottenActive: 0 },
  })]);

  r.alert('hard-down-clear', 'clear after restart', 631);
  r.alert('hard-down', 'observed again', 630);
  await r.settle();
  const after = await journal(h.dir);
  expect(observed(after, 631)).toMatchObject({ phase: 'recovery-observed', incidentId: null });
  expect(observed(after, 630).incidentId).not.toBe(priorId);
});

test('restart and later saves never overwrite or truncate an earlier archive', async () => {
  const dir = await scratch();
  const path = join(dir, 'journal.json');
  const previous = Buffer.from([0xff, 0xfe, 0x00, 0x37]); // Opaque bytes; never parsed.
  await writeFile(path, previous, { mode: 0o600 });
  const h = await harness({ dir });
  await h.module.stop();
  const archives = await movedAside(dir);
  expect(Object.values(archives)).toEqual([previous]);

  // A stale staging entry can be another link to an earlier archive.
  await link(join(dir, Object.keys(archives)[0]!), join(dir, 'journal.next'));
  const before = await readFile(path);
  const r = await harness({ dir, instance: 'next-run' });
  r.alert('hard-down', 'new observation', 632);
  await r.settle();
  expect(delivered(r.calls, observed(await journal(dir), 632))).toBe(true);
  const after = await movedAside(dir);
  expect(after).toMatchObject(archives);
  expect(Object.keys(after)).toHaveLength(3);
  expect(Object.entries(after).filter(([name]) => !Object.hasOwn(archives, name)).map(([, bytes]) => bytes))
    .toEqual(expect.arrayContaining([before, previous]));
});

async function onlyArchivedEntry(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter(name => name.startsWith('journal.archived-'));
  expect(names).toHaveLength(1);
  return join(dir, names[0]!);
}

test.each([
  ['staging target', 'journal.json', 'journal.next'],
  ['separately named target', 'journal.json', 'previous.json'],
  ['absolute target outside the journal directory', 'journal.json', 'absolute'],
  ['dangling active pointer', 'journal.json', 'missing.json'],
  ['dangling staging pointer', 'journal.next', 'missing.json'],
])('startup archives the journal link itself: %s', async (_label, name, target) => {
  const dir = await scratch();
  const bytes = Buffer.from([0xff, 0x00, 0xfe]);
  const hasTarget = target !== 'missing.json';
  const link = target === 'absolute' ? join(await scratch(), 'previous.json') : target;
  const targetPath = target === 'absolute' ? link : join(dir, link);
  if (hasTarget) await writeFile(targetPath, bytes, { mode: 0o600 });
  const path = join(dir, name);
  await symlink(link, path);
  const pointer = await lstat(path);

  const h = await harness({ dir });
  expect(h.module.homeState()?.disabled).toBeNull();
  expect(await journal(dir)).toMatchObject({ active: [], records: [{ kind: 'startup-observation' }] });
  // A stale journal.next is archived in its own right, never by following a link.
  const names = (await readdir(dir)).filter(name => name.startsWith('journal.archived-'));
  const archives = await Promise.all(names.map(async name => {
    const path = join(dir, name);
    return { path, stat: await lstat(path) };
  }));
  const links = archives.filter(entry => entry.stat.isSymbolicLink());
  expect(links).toHaveLength(1);
  expect(links[0]!.stat.ino).toBe(pointer.ino);
  expect(await readlink(links[0]!.path)).toBe(link);
  const files = archives.filter(entry => entry.stat.isFile());
  expect(files).toHaveLength(target === 'journal.next' ? 1 : 0);
  if (target === 'journal.next') expect(await readFile(files[0]!.path)).toEqual(bytes);
  if (hasTarget && target !== 'journal.next') expect(await readFile(targetPath)).toEqual(bytes);
  else await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a dangling journal link ending in a slash does not move the regular file', async () => {
  const dir = await scratch();
  const path = join(dir, 'journal.json');
  const ordinary = join(dir, 'ordinary');
  await writeFile(ordinary, 'unrelated');
  await symlink('ordinary/', path);
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOTDIR' });

  const h = await harness({ dir });
  expect(h.module.homeState()?.disabled).toBeNull();
  expect(await readFile(ordinary, 'utf8')).toBe('unrelated');
  expect(await readlink(await onlyArchivedEntry(dir))).toBe('ordinary/');
});

test.skipIf(process.platform !== 'linux')('a non-UTF-8 journal link target never selects its UTF-8 lookalike', async () => {
  const dir = await scratch();
  const path = join(dir, 'journal.json');
  const raw = Buffer.from([0xff]);
  const target = Buffer.concat([Buffer.from(dir + '/'), raw]);
  const lookalike = join(dir, '\ufffd');
  await writeFile(target, 'target bytes');
  await writeFile(lookalike, 'unrelated');
  await symlink(raw, path);
  expect(await readFile(path, 'utf8')).toBe('target bytes');

  const h = await harness({ dir });
  expect(h.module.homeState()?.disabled).toBeNull();
  expect(await readFile(lookalike, 'utf8')).toBe('unrelated');
  expect(await readFile(target, 'utf8')).toBe('target bytes');
  expect(await readlink(await onlyArchivedEntry(dir), { encoding: 'buffer' })).toEqual(raw);
});

test('session switch moves both journal files aside and starts new incident IDs in the same host', async () => {
  const h = await harness();
  h.alert('hard-down', 'old session', 640);
  await h.settle();
  const old = await readFile(join(h.dir, 'journal.json'));
  const prior = JSON.parse(old.toString());
  const staging = Buffer.from('old session staging evidence');

  expect(await switchSessionSteps({}, {
    stopOld: async () => {
      await h.module.stop();
      await writeFile(join(h.dir, 'journal.next'), staging, { mode: 0o600 });
    },
    make: async () => {
      await h.bindFramework();
      return h.module;
    },
    install: () => h.settle(),
    stopServer: async () => {},
  })).toBe(true);

  const fresh = await journal(h.dir);
  expect(fresh.currentInstance).toBe(prior.currentInstance);
  expect(fresh.active).toEqual([]);
  expect(fresh.records).toEqual([expect.objectContaining({ kind: 'startup-observation' })]);
  h.alert('hard-down-clear', 'clear after switch', 641);
  h.alert('hard-down', 'new session', 642);
  await h.settle();
  const current = await journal(h.dir);
  expect(observed(current, 641)).toMatchObject({ phase: 'recovery-observed', incidentId: null });
  expect(typeof observed(current, 642).incidentId).toBe('string');
  expect(observed(current, 642).incidentId).not.toBe(observed(prior, 640).incidentId);
  const archives = Object.values(await movedAside(h.dir));
  expect(archives).toHaveLength(2);
  expect(archives).toEqual(expect.arrayContaining([old, staging]));
});

test('source replay dedups; fresh repeats coalesce without using diagnostic text', async () => {
  const h = await harness();
  h.alert('future', 'first diagnostic', 301, { traceId: 'trace-a' }); await h.settle();
  const sent = h.calls.length;
  h.alert('future', 'changed replay text', 301, { traceId: 'trace-a' }); await h.settle();
  h.tick();
  h.alert('future', 'same timestamp, distinct ID', 301, { traceId: 'trace-b' }); await h.settle();
  const first = observed(await journal(h.dir), 301);
  expect(first.count).toBe(2);
  expect(first.lastSeen).toBeGreaterThan(first.observedAt);
  h.alert('future', 'another fresh diagnostic', 303); await h.settle();
  expect(h.calls).toHaveLength(sent);
  const j = await journal(h.dir);
  expect(observed(j, 301)).toMatchObject({ count: 3, lastSource: { timestamp: 303 } });
  expect(j.active[0].id).toBe(first.incidentId);
  h.alert('future-clear', 'clear', 304);
  h.alert('future', 'new episode', 305);
  await h.settle();
  const after = await journal(h.dir);
  expect(observed(after, 304)).toMatchObject({ phase: 'recovery-observed', incidentId: first.incidentId });
  expect(observed(after, 305).incidentId).not.toBe(first.incidentId);
});

for (const [label, setup, reason] of [
  ['disconnected', (h: any) => { h.servers[0].connected = false; }, 'bound-server-unavailable'],
  ['missing server', (h: any) => { h.servers = []; }, 'bound-server-missing-or-ambiguous'],
  ['ambiguous server', (h: any) => { h.servers.push({ ...h.servers[0] }); }, 'bound-server-missing-or-ambiguous'],
  ['prefix drift', (h: any) => { h.servers[0].toolPrefix = 'another-prefix'; }, 'server-prefix-drift'],
  ['tool ownership mismatch', (h: any) => { h.servers[0].toolClasses = []; }, 'tool-not-owned-by-bound-server'],
  ['observable realm mismatch', (h: any) => { h.servers[0].realm = 'https://wrong.invalid'; }, 'observable-realm-mismatch'],
  ['no tool', (h: any) => { h.tools = []; }, 'missing-send-message-or-inline-attachment-capability'],
  ['ambiguous tool', (h: any) => { h.tools.push({ ...h.tools[0] }); }, 'missing-send-message-or-inline-attachment-capability'],
  ['no inline upload capability', (h: any) => { delete h.tools[0].inputSchema.properties.attachments; }, 'missing-send-message-or-inline-attachment-capability'],
  ['bad upload schema', (h: any) => { delete h.tools[0].inputSchema.properties.attachments.items.properties.data; }, 'missing-inline-attachment-schema'],
  ['private-only schema', (h: any) => { h.tools[0].inputSchema.properties.type.enum = ['private']; }, 'unsupported-explicit-stream-schema'],
  ['server inspection throws', (h: any) => { h.inspectThrows = 'servers'; }, 'backend-inspection-failed: server-list; inspect host MCPL configuration/logs'],
  ['tool inspection throws', (h: any) => { h.inspectThrows = 'tools'; }, 'backend-inspection-failed: tool-list/schema; inspect host MCPL configuration/logs'],
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
] as const) test(`ambiguous dispatch: ${label}; durable uncertainty`, async () => {
  const h = await harness({ sendTimeoutMs: label === 'timeout' ? 25 : undefined });
  h.state.result = result;
  h.alert('future', 'once', 501); await h.settle();
  expect(h.calls).toHaveLength(2); // startup then one incident; its status stays local.
  const j = await journal(h.dir);
  expect(observed(j, 501).outcome.state).toBe('uncertain');
});

test('late acknowledgement after timeout never upgrades uncertainty or triggers resend', async () => {
  const h = await harness({ sendTimeoutMs: 25 });
  let finish!: (r: ToolResult) => void;
  let late!: Promise<ToolResult>;
  h.state.result = () => late = new Promise((resolve) => { finish = resolve; });
  h.alert('future', 'late send', 550); await h.settle();
  finish({ success: true, structured: { result: 'success', id: 99 } });
  await late;
  await new Promise<void>(r => setImmediate(r));
  await h.settle();
  expect(observed(await journal(h.dir), 550).outcome.state).toBe('uncertain');
  expect(h.calls).toHaveLength(2);
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

test('R8: running full journal preserves exact active evidence and surviving unknowns while rolling the finite window', async () => {
  const h = await harness();
  h.state.result = async () => ({ success: false });
  h.alert('original', 'active anchor', 10);
  await h.settle();
  for (let i = 0; i < 125; i++) {
    h.alert('other-clear', 'unmatched clear', 20 + i);
    await h.settle();
  }
  const before = await journal(h.dir);
  expect(before.records).toHaveLength(128);
  const anchor = observed(before, 10);
  expect(anchor.outcome.state).toBe('uncertain');
  h.state.result = async () => ({ success: true, structured: { result: 'success', id: h.calls.length } });
  const calls = h.calls.length;
  h.alert('future', 'new incident at capacity', 800);
  await h.settle();
  const j = await journal(h.dir);
  expect(h.module.homeState()?.disabled).toBeNull();
  expect(h.calls).toHaveLength(calls + 2);
  expect(j.records).toHaveLength(128);
  expect(j.retention.evicted).toBe(2);
  expect(j.records.slice(0, -2)).toEqual([anchor, ...before.records.slice(3)]);
  expect(observed(j, 800).outcome.state).toBe('sent');
  expect((await stat(join(h.dir, 'journal.json'))).size).toBeLessThanOrEqual(2 * 1024 * 1024);
}, 30000);

test('a repeat refreshes the anchor position without replacing its receipt', async () => {
  const h = await harness();
  h.alert('future', 'episode A', 801); await h.settle();
  h.alert('another', 'episode B', 802); await h.settle();
  const before = await journal(h.dir);
  const a = observed(before, 801);
  expect(before.records.at(-1).id).not.toBe(a.id);
  h.alert('future', 'episode A repeat', 803); await h.settle();
  const after = await journal(h.dir);
  expect(after.records.at(-1)).toMatchObject({ id: a.id, count: 2, outcome: a.outcome, lastSource: { timestamp: 803 } });
  expect(after.active.some((x: any) => x.id === a.incidentId)).toBe(true);
  expect(h.calls.filter(c => c.id === `notice-home-${a.id}`)).toHaveLength(1);
});

test('R1: overflow drops only excess observations, drains accepted work and accepts later work', async () => {
  const h = await harness({ sendTimeoutMs: HELD_SEND_TIMEOUT_MS });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const stalled = new Promise<void>(r => { release = r; });
  h.state.result = async () => { entered(); await stalled; return { success: true, structured: { result: 'success', id: 1 } }; };
  h.alert('future', 'first stalled', 2000);
  await started;
  for (let i = 1; i < 100; i++) h.alert(`burst-kind-${i}`, 'burst', 2000 + i);
  expect(h.module.homeState()?.queued).toBe(64);
  expect(h.module.homeState()?.dropped).toBe(36);
  expect(h.module.homeState()?.disabled).toBeNull();
  release(); await h.settle();
  const j = await journal(h.dir);
  expect(j.records.filter((r: any) => r.phase === 'incident')).toHaveLength(64);
  expect(observed(j, 2063).outcome.state).toBe('sent');
  h.alert('after-overflow', 'after overflow', 2200); await h.settle();
  expect(delivered(h.calls, observed(await journal(h.dir), 2200))).toBe(true);
  expect(h.module.homeState()?.queued).toBe(0);
  expect(await h.module.onProcess({ type: 'normal:event' } as never, {} as never)).toEqual({});
}, 60000);

test('R1 replay: oversized synchronous startup replay cannot disable loading or subsequent live delivery', async () => {
  const h = await harness({ setup: h => {
    h.early = Array.from({ length: 90 }, (_, i) => ({ type: 'ops:alert', kind: `early-kind-${i}`, agentName: 'worker', timestamp: i, message: 'early' }));
  } });
  expect(h.module.homeState()?.disabled).toBeNull();
  expect(h.module.homeState()?.dropped).toBe(27); // startup + 63 accepted replay items
  expect((await journal(h.dir)).records.filter((r: any) => r.phase === 'incident')).toHaveLength(63);
  h.alert('future', 'live after replay', 200); await h.settle();
  expect(delivered(h.calls, observed(await journal(h.dir), 200))).toBe(true);
}, 60000);

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
    expect(posts.some(c => {
      const r = JSON.parse(Buffer.from((c.input as any).attachments[0].data, 'base64').toString()).record;
      return r.kind === 'unknown-alert-kind' && r.phase === 'incident' && r.source.timestamp === 1000;
    })).toBe(true);
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
test('fix1 F2: startup connecting, actual mcpl-down/reconnect, and new incident do not latch', async () => {
  const h = await harness({ setup: h => { h.servers[0].connected = false; } });
  h.emit({ type: 'ops:alert', kind: 'mcpl-down', agentName: 'chat-ops', timestamp: 110, message: 'MCP server unreachable (attempt 1)' });
  await h.settle();
  const old = (await journal(h.dir)).records.map((r: any) => r.id);
  h.state.servers[0].connected = true;
  h.emit({ type: 'mcpl:server-reconnected', serverId: 'chat-ops', timestamp: 111 }); await h.settle();
  h.alert('independent', 'new incident', 112); await h.settle();
  expect(delivered(h.calls, observed(await journal(h.dir), 112))).toBe(true);
  expect((await journal(h.dir)).records.filter((r: any) => old.includes(r.id)).every((r: any) => r.outcome.state === 'not-dispatched')).toBe(true);
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
  expect(j.records.find((r: any) => r.kind === 'refusal' && r.phase === 'recovery-observed').source.type).toBe('inference:turn_ended');
  h.alert('context-maintenance-failed-clear', 'specific source clear', 140); await h.settle();
  expect((await journal(h.dir)).active.map((a: any) => a.kind)).toEqual(['refusal-offpath']);
});

test('fix1 F5: >128 healthy reconnect notices compact; the active incident anchor survives as uncertain', async () => {
  const h = await harness();
  h.state.result = async () => ({ success: false });
  h.alert('unknown-delivery', 'never replay', 150); await h.settle();
  const uncertain = observed(await journal(h.dir), 150);
  h.state.result = async () => ({ success: true, structured: { result: 'success', id: h.calls.length } });
  for (let i = 0; i < 70; i++) {
    h.emit({ type: 'ops:alert', kind: 'mcpl-down', agentName: 'chat-ops', timestamp: 200 + i * 2, message: `MCP server unreachable (attempt ${i})` }); await h.settle();
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'chat-ops', timestamp: 201 + i * 2 }); await h.settle();
  }
  h.alert('fresh', 'fresh after compaction', 400); await h.settle();
  expect(h.module.homeState()?.disabled).toBeNull();
  expect(h.calls.length).toBeGreaterThan(128);
  expect(delivered(h.calls, observed(await journal(h.dir), 400))).toBe(true);
  const j = await journal(h.dir);
  expect(j.records.length).toBeLessThanOrEqual(128);
  expect(j.retention.evicted).toBeGreaterThan(0);
  expect(observed(j, 400).outcome.state).toBe('sent');
  console.log('fix1 bounded-retention witness', JSON.stringify({ calls: h.calls.length, retained: j.records.length, evicted: j.retention.evicted, bytes: (await stat(join(h.dir, 'journal.json'))).size }));
  expect(j.records.find((r: any) => r.id === uncertain.id).outcome.state).toBe('uncertain');
  expect((await stat(join(h.dir, 'journal.json'))).size).toBeLessThan(2 * 1024 * 1024);
}, 30000);

test('fix1 F1: actual fork nullable explicit stream schema dispatches; later schema refusal recovers', async () => {
  const h = await harness({ setup: h => { h.tools[0].inputSchema = forkSchema(); } });
  expect(h.calls).toHaveLength(1);
  expect((h.calls[0]!.input as any).reply_to).toBeUndefined();
  h.state.tools[0].inputSchema.properties.type = { type: ['null'] };
  h.alert('schema-refused', 'no post', 610); await h.settle();
  const refused = observed(await journal(h.dir), 610);
  expect(refused.outcome.state).toBe('not-dispatched');
  h.state.tools[0].inputSchema = forkSchema();
  h.alert('schema-recovered', 'new safe post', 611); await h.settle();
  expect(delivered(h.calls, observed(await journal(h.dir), 611))).toBe(true);
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

test('fix1 F1b: fork legacy/compat/strict receipts retain opaque server-scoped IDs', async () => {
  for (const ids of [[42, 43], ['realm:42', 'realm:43'], ['other-realm_2:42', 'other-realm_2:43']]) {
    const h = await harness({ setup: h => { h.result = async () => ({ success: true, structured: {
      result: 'success', id: ids[0], ids, type: 'stream', stream: 'private-ops', topic: 'agent status', channelId: 'zulip:private-ops',
    } }); } });
    const j = await journal(h.dir);
    expect(j.records[0].outcome).toEqual({ state: 'sent', messageIds: ids });
  }
});

test('fix1 F1b: malformed or mismatched receipts are uncertain', async () => {
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
    const old = (await journal(h.dir)).records[0];
    expect(old.outcome.state).toBe('uncertain');
  }
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

test('fix1 F1b: actual single JSON content branded acknowledgement', async () => {
  const h = await harness({ setup: h => { h.tools[0].inputSchema = forkSchema(); h.result = async () => ({ success: true,
    data: [{ type: 'text', text: JSON.stringify({ result: 'success', id: 'realm:42', ids: ['realm:42', 'realm:43'] }) }],
  }); } });
  const j = await journal(h.dir);
  const old = j.records[0];
  expect(old.outcome).toEqual({ state: 'sent', messageIds: ['realm:42', 'realm:43'] });
});

test('fix1 F2: delayed publication failure after timeout cannot recurse; new independent incident still delivers', async () => {
  const h = await harness({ sendTimeoutMs: 25 });
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
  expect(observed(j, 800).outcome.state).toBe('uncertain');
  expect(j.records.find((r: any) => r.kind === 'mcpl-down').outcome.state).toBe('not-dispatched');
  h.state.result = async () => ({ success: true, structured: { result: 'success', id: h.calls.length } });
  h.emit({ type: 'mcpl:server-reconnected', serverId: 'chat-ops', timestamp: 811 }); await h.settle();
  h.alert('new-independent', 'new independent incident after recovery', 812); await h.settle();
  j = await journal(h.dir);
  expect(observed(j, 812).outcome.state).toBe('sent');
  expect(observed(j, 800).outcome.state).toBe('uncertain');
});


for (const [first, ownCallbacks] of [['status', false], ['incident', false], ['incident', true]] as const) {
  test(`fix2 N1: slow successful ${first} send queues outside-context burst; own callbacks=${ownCallbacks}`, async () => {
    const h = await harness({ sendTimeoutMs: HELD_SEND_TIMEOUT_MS, setup: h => {
      if (first === 'status') h.result = async () => ({ success: false });
    } });
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
      h.emit({ type: 'mcpl:server-reconnected', serverId: 'chat-ops', timestamp: 900 });
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
    const external = j.records.filter((r: any) => r.phase === 'incident' && r.incidentKey !== keyFor('mcpl-down', 'chat-ops'));
    expect(external.map((r: any) => r.kind)).toEqual(first === 'status'
      ? ['hard-down', 'store-held-lost'] : ['mcpl-down', 'hard-down', 'store-held-lost']);
    for (const r of external) {
      expect(r.outcome.state).toBe('sent');
      expect(h.calls.filter(c => c.id === `notice-home-${r.id}`)).toHaveLength(1);
    }
    // Their derived statuses are delivered, not silently made local-only.
    for (const kind of ['hard-down', 'store-held-lost']) {
      expect(j.records.some((r: any) => r.phase === 'status' && r.outcome.state === 'sent' && r.tracking.activeIncidentIds.includes(j.records.find((x: any) => x.kind === kind && x.phase === 'incident').incidentId))).toBe(true);
    }
    const own = j.records.filter((r: any) => r.phase === 'incident' && r.incidentKey === keyFor('mcpl-down', 'chat-ops'));
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
  h.state.servers[0].connected = true;
  h.emit({ type: 'mcpl:server-reconnected', serverId: 'chat-ops', timestamp: 912 }); await h.settle();
  const before = h.calls.length; // New, previously undelivered status may publish on recovery.
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
    source: { timestamp: 914 }, outcome: { state: 'sent' } });
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
  const clear = j.records.find((r: any) => r.kind === 'hard-down' && r.phase === 'recovery-observed');
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

// First-review regressions use NoticesModule lifecycle and subscribed traces,
// not NoticeHome's private implementation.
test('R2: a status suppressed by failed incident delivery does not become the sent baseline', async () => {
  const h = await harness();
  h.state.servers[0].connected = false;
  h.alert('future', 'offline', 9001); await h.settle();
  const before = await journal(h.dir);
  const pending = before.records.at(-1);
  expect(pending.phase).toBe('status');
  expect(pending.outcome.state).toBe('not-dispatched');
  for (let i = 0; i < 3; i++) {
    h.state.status = 'running';
    h.trace('inference:started'); await h.settle();
    h.trace('inference:turn_ended'); await h.settle();
  }
  expect((await journal(h.dir)).records).toEqual(before.records);
  h.state.servers[0].connected = true;
  h.emit({ type: 'mcpl:server-reconnected', serverId: 'chat-ops', timestamp: 9002 }); await h.settle();
  const after = await journal(h.dir);
  expect(after.records.at(-1)).toMatchObject({ phase: 'status', tracking: pending.tracking, outcome: { state: 'sent' } });
  expect(h.calls).toHaveLength(2);
  expect(after.records.find((r: any) => r.id === pending.id).outcome.state).toBe('not-dispatched');
  h.emit({ type: 'mcpl:server-reconnected', serverId: 'chat-ops', timestamp: 9003 }); await h.settle();
  expect(h.calls).toHaveLength(2); // A delivered identical state DOES dedup.
});

test('R3: more than 64 unresolved identities bound tracking without disabling delivery or claiming recovery', async () => {
  const h = await harness();
  for (let i = 0; i < 70; i++) {
    h.alert(`unknown-${i}`, `incident ${i}`, 10000 + i, { agentName: `child-${i}` });
    await h.settle();
  }
  const j = await journal(h.dir);
  expect(h.module.homeState()?.disabled).toBeNull();
  expect(j.active).toHaveLength(64);
  expect(j.retention.forgottenActive).toBe(6);
  expect(j.records.some((r: any) => r.phase === 'recovery-observed')).toBe(false);
  expect(j.records.at(-1).tracking).toEqual({ activeIncidentIds: j.active.map((a: any) => a.id), forgottenActive: 6 });
  h.alert('unknown-69-clear', 'latest source clear', 10100, { agentName: 'child-69' });
  await h.settle();
  expect((await journal(h.dir)).active).toHaveLength(63);
}, 60000);

test('R4: uncertainty rolls through bounded retention, without a lifetime halt', async () => {
  const h = await harness();
  h.state.result = async () => ({ success: true, data: [] }); // malformed acknowledgement
  for (let i = 0; i < 140; i++) { h.alert(`uncertain-${i}`, 'uncertain', 11000 + i); await h.settle(); }
  const j = await journal(h.dir);
  expect(h.module.homeState()?.disabled).toBeNull();
  expect(j.records).toHaveLength(128);
  expect(j.retention.evicted).toBe(153); // Startup + 140 unsent statuses + 140 incidents - 128.
  expect(j.records.filter((r: any) => r.phase === 'incident').every((r: any) => r.outcome.state === 'uncertain')).toBe(true);
  expect(observed(j, 11139).outcome.state).toBe('uncertain');
}, 60000);

test('R5: child turn-end closes only the matching child main-turn incidents', async () => {
  const h = await harness();
  h.alert('hard-down', 'child failed', 13000, { agentName: 'child-A' });
  h.alert('hard-down', 'other child failed', 13001, { agentName: 'child-B' });
  h.alert('context-maintenance-failed', 'auxiliary failed', 13002, { agentName: 'child-A' });
  await h.settle();
  h.emit({ type: 'inference:turn_ended', agentName: 'child-A', timestamp: 13003 }); await h.settle();
  const j = await journal(h.dir);
  expect(j.active.map((a: any) => a.key)).toEqual([keyFor('hard-down', 'child-B'), keyFor('context-maintenance-failed', 'child-A')]);
  expect(j.records.find((r: any) => r.phase === 'recovery-observed')).toMatchObject({ incidentId: observed(j, 13000).incidentId, kind: 'hard-down', outcome: { state: 'sent' } });
});

test('R7: misspelled server binding reports the invalid ID and configured candidates, not disconnection', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const h = await harness({ config: { ...binding(), serverId: 'chat-opz' }, setup: h => { h.servers[0].id = 'chat-ops'; } });
    expect(h.calls).toHaveLength(0);
    expect((await journal(h.dir)).records[0].outcome.detail).toBe('bound-server-missing-or-ambiguous');
    const text = log.mock.calls.flat().join(' ');
    expect(text).toContain('chat-opz'); expect(text).toContain('chat-ops');
    expect(text).toContain('check home.serverId');
    expect(text).toContain('runtime MCPL overlay');
    expect(text).toContain('archive the old private journal directory');
  } finally { log.mockRestore(); }
});

test('R9: the unreleased home is described under Added, not as fixes to a prior release', async () => {
  // Release metadata has no delivery behavior; inspect the shipped fragments.
  const names = await readdir(new URL('../changelog.d/', import.meta.url));
  expect(names).not.toContain('zulip-home-fix1.fixed.md');
  expect(names).not.toContain('zulip-home-fix2.fixed.md');
  expect(names).not.toContain('663-notice-home-log-tags.fixed.md');
  expect(await readFile(new URL('../changelog.d/agent-service-home.added.md', import.meta.url), 'utf8')).toContain('per-record no-retry');
});

test('stop drains accepted work, rejects later traces and settles before returning', async () => {
  const h = await harness({ sendTimeoutMs: HELD_SEND_TIMEOUT_MS });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const stalled = new Promise<void>(r => { release = r; });
  h.state.result = async () => { entered(); await stalled; return { success: true, structured: { result: 'success', id: 1 } }; };
  const timers = spyOn(globalThis, 'setTimeout');
  try {
    h.alert('future', 'in flight', 15000); await started;
    const deadline = timers.mock.calls.at(-1)?.[1];
    h.alert('accepted', 'accepted before stop', 15001);
    const stopping = h.module.stop();
    h.alert('future', 'after stop', 15002);
    release(); await stopping;
    expect(deadline).toBe(HELD_SEND_TIMEOUT_MS);
  } finally { release(); timers.mockRestore(); }
  const j = await journal(h.dir);
  expect(observed(j, 15001)).toMatchObject({ outcome: { state: 'sent' } });
  expect(observed(j, 15002)).toBeUndefined();
  expect(h.module.homeState()?.queued).toBe(0);
});


test('review2 3: stop shares one deadline and retains accepted evidence when a queued send stalls', async () => {
  const h = await harness({ sendTimeoutMs: 1000 });
  const before = h.calls.length;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  const ok = { success: true, structured: { result: 'success', id: 1 } };
  const originalNow = performance.now.bind(performance);
  let elapsed = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => originalNow() + elapsed);
  const timers = spyOn(globalThis, 'setTimeout');
  let stalledDeadline: number | undefined;
  try {
    h.state.result = async () => {
      if (h.calls.length === before + 1) { entered(); await held; }
      if (h.calls.length === before + 2) {
        stalledDeadline = timers.mock.calls.at(-1)?.[1];
        return new Promise<never>(() => {});
      }
      return ok;
    };
    h.alert('in-flight-clear', 'in flight', 15010); await started;
    const queued = Array.from({ length: 63 }, (_, i) => `queued-${i}`);
    for (const [i, kind] of queued.entries()) h.alert(kind, 'queued', 15011 + i);
    expect(h.module.homeState()?.queued).toBe(64);
    const stopping = h.module.stop();
    h.alert('future', 'after stop', 15100);
    elapsed = 600; // Spend shutdown budget before releasing the first acknowledgement.
    release(); await stopping;

    expect(h.calls).toHaveLength(before + 2);
    expect(stalledDeadline).toBeGreaterThan(0);
    expect(stalledDeadline).toBeLessThanOrEqual(400);
    expect(h.module.homeState()).toMatchObject({ queued: 0, dropped: 0, disabled: null });
    const j = await journal(h.dir);
    const drained = j.records.filter((r: any) => r.phase !== 'status' && r.source.timestamp >= 15010);
    expect(drained.map((r: any) => r.source.timestamp)).toEqual(Array.from({ length: 64 }, (_, i) => 15010 + i));
    expect(drained[0].outcome.state).toBe('sent');
    expect(drained[1].outcome).toMatchObject({ state: 'uncertain', detail: expect.stringContaining('dispatch-timeout') });
    for (const record of drained.slice(2)) {
      expect(record.outcome).toEqual({ state: 'not-dispatched', detail: 'shutdown-budget-exhausted' });
    }
  } finally { release(); timers.mockRestore(); clock.mockRestore(); }
}, 10000);


test('unidentified fresh alerts at the same wall-clock millisecond are not mistaken for retained replay', async () => {
  const h = await harness();
  h.state.servers[0].connected = false;
  h.alert('future', 'no source identity', 18000, { timestamp: undefined }); await h.settle();
  h.state.servers[0].connected = true;
  h.alert('future', 'no source identity', 18000, { timestamp: undefined }); await h.settle();
  const incidents = (await journal(h.dir)).records.filter((r: any) => r.phase === 'incident');
  expect(incidents).toHaveLength(2);
  expect(delivered(h.calls, incidents[1])).toBe(true);
});
