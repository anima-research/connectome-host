import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, type Module, type ModuleContext, type ProcessEvent } from '@animalabs/agent-framework';
import { Membrane, MockAdapter } from '@animalabs/membrane';
import { historyUserLine } from '../src/tui.js';
import { toWireEntry } from '../src/modules/web-ui-module.js';
import { TimeModule } from '../src/modules/time-module.js';
import { LifecycleModule } from '../src/modules/lifecycle-module.js';
import { SubagentModule } from '../src/modules/subagent-module.js';
import { TtsRelayModule } from '../src/modules/tts-relay-module.js';
import { SelfRestartState } from '../src/self-restart.js';

const row = (metadata: unknown, text = 'hello') => ({
  id: 'r1',
  participant: 'user',
  content: [{ type: 'text', text }],
  metadata,
});

function shown(metadata: unknown, text = 'hello') {
  const m = row(metadata, text);
  return { tui: historyUserLine(m, text).text, web: toWireEntry(m, 0).speaker };
}

const surface = { inboundSource: { kind: 'surface', surface: 'tui', acceptedAt: 1 } };
const channel = {
  author: { id: 'u42', name: 'alice' },
  inboundSource: { kind: 'channel', lane: 'channels/incoming', serverId: 'discord', binding: 'b1', channelId: 'discord:42', label: '#general', acceptedAt: 1 },
};
const push = { inboundSource: { kind: 'unscoped', lane: 'push/event', serverId: 'heartbeat', binding: 'b2', acceptedAt: 1 } };

describe('a row reads as "you" only when it came in as the host\'s own input', () => {
  test('typed input reads as you on both screens', () => {
    expect(shown(surface)).toEqual({ tui: 'You: hello', web: 'you' });
  });

  test('a row with no source reads as its stored participant, never you', () => {
    expect(shown(undefined)).toEqual({ tui: 'user: hello', web: 'user' });
    expect(shown({ exportSource: { originalSender: 'nissa' } })).toEqual({ tui: 'user: hello', web: 'user' });
  });

  test('a source that doesn\'t read as one, such as a damaged import\'s, is no source', () => {
    expect(shown({ inboundSource: { kind: 'surface', surface: '', acceptedAt: 1 } })).toEqual({ tui: 'user: hello', web: 'user' });
    expect(shown({ inboundSource: { kind: 'surface', surface: 'tui' } })).toEqual({ tui: 'user: hello', web: 'user' });
  });
});

describe('the host\'s own rows read as the host\'s, by kind', () => {
  test('a host mark wins over a surface stamp, and a server\'s own mark is no host\'s', () => {
    expect(shown({ ...surface, hostNote: 'session-start' }).web).toBe('host · session start');
    expect(shown({ ...channel, hostNote: 'session-start' }).web).toBe('alice in #general');
    expect(shown({ ...push, hostNote: 'restart' }).web).toBe('heartbeat (push)');
    const damaged = { ...channel, inboundSource: { ...channel.inboundSource, acceptedAt: undefined } };
    expect(shown({ ...damaged, hostNote: 'session-start' }).web).toBe('user');
  });

  test('a server\'s row with agent-framework\'s own host mark is still the server\'s', () => {
    expect(shown({ ...channel, system: true, kind: 'clock' })).toEqual({ tui: 'alice in #general: hello', web: 'alice in #general' });
    expect(shown({ ...push, system: true, kind: 'host-notice' }).web).toBe('heartbeat (push)');
    const damaged = { ...channel, inboundSource: { ...channel.inboundSource, acceptedAt: undefined } };
    expect(shown({ ...damaged, system: true, kind: 'clock' }).web).toBe('user');
    expect(shown({ ...damaged, system: true }).web).toBe('user');
  });

  test('agent-framework\'s clock row and a host notice', () => {
    expect(shown({ system: true, kind: 'clock', clock: { at: 1, onBoundary: true, zone: 'UTC' } }, 'Clock: Monday'))
      .toEqual({ tui: 'host · clock: Clock: Monday', web: 'host · clock' });
    expect(shown({ system: true, kind: 'host-notice' })).toEqual({ tui: 'host · notice: hello', web: 'host · notice' });
    expect(shown({ system: true })).toEqual({ tui: 'host: hello', web: 'host' });
  });

  test('the time module\'s session-start note', async () => {
    const written: unknown[] = [];
    const roles: string[] = [];
    const ctx = {
      getState: () => undefined,
      setState: () => {},
      addMessage: (p: string, _c: unknown, metadata?: unknown) => { written.push(metadata); roles.push(p); return 'm1'; },
    } as unknown as ModuleContext;
    await new TimeModule('UTC').start(ctx);
    expect(written).toHaveLength(1);
    expect(shown(written[0]).web).toBe('host · session start');
    expect((written[0] as { system?: unknown }).system).toBeUndefined();
    expect(roles).toEqual(['user']);
  });

  test('the lifecycle module\'s note after a restart it asked for', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'speakers-restart-'));
    try {
      const before = new SelfRestartState('boot-a');
      before.attachHeadless();
      const first = new LifecycleModule({ dataDir, timeZone: 'UTC', state: before, now: () => new Date('2026-10-20T12:00:00Z'), hostVersion: '9.9.9' });
      await first.handleToolCall({ id: 'c1', name: 'restart', input: { reason: 'update' }, callerAgentName: 'main' } as never);
      before.recordExit('SIGTERM', 0, new Date('2026-10-20T12:00:10Z'));
      const written: unknown[] = [];
      const roles: string[] = [];
      const ctx = { addMessage: (p: string, _c: unknown, metadata?: unknown) => { written.push(metadata); roles.push(p); return 'm1'; } } as unknown as ModuleContext;
      const after = new LifecycleModule({ dataDir, timeZone: 'UTC', state: new SelfRestartState('boot-b'), now: () => new Date('2026-10-20T12:01:00Z'), hostVersion: '9.9.9' });
      await after.start(ctx);
      expect(written).toHaveLength(1);
      expect(shown(written[0]).web).toBe('host · restart');
      expect((written[0] as { system?: unknown }).system).toBeUndefined();
      expect(roles).toEqual(['user']);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('the subagent module\'s report that a subagent returned or failed', () => {
    const written: unknown[] = [];
    const roles: string[] = [];
    const mod = new SubagentModule({ provider: 'mock' });
    const inner = mod as unknown as {
      ctx: ModuleContext;
      addForLauncher(launcher: string | undefined, shownAs: string | undefined, name: string, outcome: 'returned' | 'failed', body: string): string | null;
    };
    inner.ctx = { addMessage: (p: string, _c: unknown, metadata?: unknown) => { written.push(metadata); roles.push(p); return 'm1'; } } as unknown as ModuleContext;
    inner.addForLauncher(undefined, undefined, 'scout', 'returned', 'done');
    inner.addForLauncher(undefined, undefined, 'scout', 'failed', 'Error: x');
    expect(written.map((m) => shown(m).web)).toEqual(['host · subagent returned', 'host · subagent failed']);
    expect(written.map((m) => (m as { system?: unknown }).system)).toEqual([undefined, undefined]);
    expect(roles).toEqual(['user', 'user']);
  });

  test('the TTS relay\'s note that a reply was interrupted', async () => {
    const written: unknown[] = [];
    const roles: string[] = [];
    const mod = new TtsRelayModule({ url: 'ws://127.0.0.1:1/bot', token: 't' });
    const inner = mod as unknown as {
      ctx: ModuleContext;
      handleInterruption(ev: { channelId: string; spokenText: string; reason: 'user_speech'; timestamp: number }): Promise<void>;
    };
    inner.ctx = {
      callTool: async () => ({ success: true, data: [] }),
      addMessage: (p: string, _c: unknown, metadata?: unknown) => { written.push(metadata); roles.push(p); return 'm1'; },
    } as unknown as ModuleContext;
    await inner.handleInterruption({ channelId: '42', spokenText: 'The ferry', reason: 'user_speech', timestamp: 2 });
    expect(written).toHaveLength(1);
    expect(shown(written[0]).web).toBe('host · voice interruption');
    expect((written[0] as { system?: unknown }).system).toBeUndefined();
    expect(roles).toEqual(['user']);
  });
});

describe('someone else\'s words read as theirs', () => {
  test('a channel message reads as its author\'s, with the channel', () => {
    expect(shown(channel)).toEqual({ tui: 'alice in #general: hello', web: 'alice in #general' });
    const unlabelled = { ...channel, author: { id: 'u42', name: '' }, inboundSource: { ...channel.inboundSource, label: undefined } };
    expect(shown(unlabelled).web).toBe('u42 in discord:42');
    expect(shown({ ...channel, author: undefined }).web).toBe('someone in #general');
    expect(shown({ ...channel, author: { id: '', name: 'alice' } }).web).toBe('alice in #general');
    expect(shown({ ...channel, author: { id: '', name: '' }, authorName: 'bob' }).web).toBe('someone in #general');
  });

  test('a push that names no channel reads as the author it names, or else as its server\'s', () => {
    expect(shown(push)).toEqual({ tui: 'heartbeat (push): hello', web: 'heartbeat (push)' });
    expect(shown({ ...push, authorName: 'alice', authorId: 'u42' }).web).toBe('alice (push from heartbeat)');
    expect(shown({ ...push, authorId: 'u42' }).web).toBe('u42 (push from heartbeat)');
  });

  test('a push to a channel reads as the author it names, or else as its server\'s in that channel', () => {
    const pushed = { inboundSource: { ...channel.inboundSource, lane: 'push/event', serverId: 'heartbeat' } };
    expect(shown({ ...pushed, authorName: 'alice', authorId: 'u42' }).web).toBe('alice in #general');
    expect(shown({ ...pushed, authorId: 'u42' }).web).toBe('u42 in #general');
    expect(shown({ ...pushed, author: { id: '', name: 'Someone' } }).web).toBe('heartbeat (push) in #general');
    expect(shown({ ...pushed, author: { id: '', name: 'Someone' }, authorName: 'alice' }).web).toBe('alice in #general');
    expect(shown({ ...pushed, author: { id: '', name: 'Bob' } }).web).toBe('Bob in #general');
    expect(shown(pushed).web).toBe('heartbeat (push) in #general');
  });
});

describe('the Web UI\'s entries', () => {
  test('only a user entry carries a speaker', () => {
    expect(toWireEntry({ id: 'a', participant: 'agent', content: [{ type: 'text', text: 'hi' }] }, 0).speaker).toBeUndefined();
    const results = { id: 't', participant: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: 'ok' }], metadata: surface };
    expect(toWireEntry(results, 0)).toMatchObject({ participant: 'tool' });
    expect(toWireEntry(results, 0).speaker).toBeUndefined();
  });
});

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) await frameworks.pop()!.stop().catch(() => {});
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

class Inbox implements Module {
  readonly name = 'inbox';
  async start(_ctx: ModuleContext) {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; }
  async onProcess(event: ProcessEvent) {
    if (event.type !== 'external-message') return {};
    const text = String((event as { content?: unknown }).content ?? '');
    return { addMessages: [{ participant: 'user', content: [{ type: 'text' as const, text }] }], requestInference: true };
  }
}

describe('the host\'s mark stays in the store', () => {
  test('a host note\'s request to the provider carries its words and not its mark', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'speakers-request-')); dirs.push(dir);
    const adapter = new MockAdapter();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new Membrane(adapter),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.' }],
      modules: [new Inbox(), new TimeModule('UTC')],
    });
    frameworks.push(framework);
    await framework.start();
    framework.pushEvent({ type: 'external-message', source: 'tui', content: 'hi there', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    const stored = framework.getAgent('prime')!.getContextManager().getAllMessages();
    const note = stored.find((m) => JSON.stringify(m.content).includes('at the start of this session'));
    expect(note && shown(note.metadata).web).toBe('host · session start');
    const typed = stored.find((m) => JSON.stringify(m.content).includes('hi there'));
    expect(typed && shown(typed.metadata).web).toBe('you');

    const requests = adapter.getRequestLog().map((r) => r.request as { messages?: Array<Record<string, unknown>> });
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      const carrying = (request.messages ?? []).find((m) => JSON.stringify(m).includes('at the start of this session'));
      expect(carrying?.role ?? carrying?.participant).toBe('user');
      expect(JSON.stringify(request)).not.toContain('hostNote');
      expect(JSON.stringify(request)).not.toContain('session-start');
    }
  });
});
