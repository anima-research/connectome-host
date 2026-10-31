/**
 * agent-framework hands a module's callTool an MCPL server's error result as a
 * failure: `success: false`, `isError: true`, its text as `error`.
 */
import { describe, expect, test } from 'bun:test';
import type { ModuleContext } from '@animalabs/agent-framework';
import { TtsRelayModule } from '../src/modules/tts-relay-module.js';

type Interruption = { channelId: string; spokenText: string; reason: 'user_speech' | 'manual' | 'timeout'; timestamp: number };

/** The module on a context whose callTool answers `answer`, with one published
 *  message posted to Discord channel 42 by `speaker`, and the notes it gives
 *  the agent, each with the agent it was written for. */
function relayWith(answer: Record<string, unknown>, opts: { agents?: string[]; speaker?: string } = {}) {
  const notes: string[] = [];
  const noteFor: Array<string | undefined> = [];
  const calls: Array<{ name: string; input: unknown }> = [];
  const ctx = {
    callTool: async (call: { name: string; input: unknown }) => { calls.push({ name: call.name, input: call.input }); return answer; },
    addMessage: (_role: string, content: Array<{ text: string }>, _metadata?: unknown, target?: { forAgent?: string }) => {
      notes.push(content.map((b) => b.text).join(''));
      noteFor.push(target?.forAgent);
    },
    getAgents: () => (opts.agents ?? ['fable']).map((name) => ({ name })),
  } as unknown as ModuleContext;
  const module = new TtsRelayModule({ url: 'ws://127.0.0.1:1/bot', token: 't' });
  const inner = module as unknown as {
    ctx: ModuleContext;
    published: Array<{ agentName: string; rawChannelId: string; mcplChannelId: string; messageId?: string; text: string; at: number }>;
    handleInterruption(ev: Interruption): Promise<void>;
  };
  inner.ctx = ctx;
  inner.published.push({ agentName: opts.speaker ?? 'fable', rawChannelId: '42', mcplChannelId: 'discord:42', messageId: 'm-1', text: 'The ferry leaves at noon, and the bridge is closed.', at: 1 });
  const interrupt = () => inner.handleInterruption({ channelId: '42', spokenText: 'The ferry leaves at noon', reason: 'user_speech', timestamp: 2 });
  return { notes, noteFor, calls, interrupt };
}

describe('an interruption\'s edit of the posted message', () => {
  test('an edit the server refuses tells the agent the message could not be trimmed', async () => {
    const { notes, calls, interrupt } = relayWith({ success: false, isError: true, error: 'Missing Permissions' });
    await interrupt();
    expect(calls).toEqual([{ name: 'mcpl--discord--edit_message', input: { channelId: '42', messageId: 'm-1', content: 'The ferry leaves at noon' } }]);
    expect(notes).toEqual(['[voice] Your reply was interrupted by user speech after: "The ferry leaves at noon" (the posted message could not be trimmed)']);
  });

  test('an edit that goes through tells the agent the message was trimmed to match', async () => {
    const { notes, interrupt } = relayWith({ success: true, data: [{ type: 'text', text: 'edited' }] });
    await interrupt();
    expect(notes).toEqual(['[voice] Your message was interrupted by user speech — only this much was voiced, and the posted message was trimmed to match: "The ferry leaves at noon"']);
  });
});

// Residents sharing a slot (agent-framework #291) are each shown a row
// stamped for them: one written for no agent is shown to every resident, so
// another agent's next request would carry "Your message was interrupted".
describe('whom the interruption note is for', () => {
  test('the agent whose published message was voiced, among several', async () => {
    const { noteFor, interrupt } = relayWith({ success: true }, { agents: ['clerk', 'mira'], speaker: 'mira' });
    await interrupt();
    expect(noteFor).toEqual(['mira']);
  });

  test('none, and no note is written, when the agent whose message it was is no longer registered', async () => {
    const { notes, interrupt } = relayWith({ success: true }, { agents: ['clerk'], speaker: 'gone' });
    const logged = await logOf(interrupt);
    expect(notes).toEqual([]);
    expect(logged).toContain('the interruption in 42 is told to no agent: gone, whose published message it was matched to, is no longer registered');
  });

  // With no published message in the interruption's channel, the speaker is
  // read from the activations: the relay's own record of who it voiced where.
  describe('with no published message matched', () => {
    /** The module on traces alone, with `agents` registered, and the notes it writes, each with the agent it was written for. */
    function relayOnActivations(agents: string[]) {
      const notes: Array<{ text: string; forAgent?: string }> = [];
      const ctx = {
        callTool: async () => ({ success: true }),
        addMessage: (_role: string, content: Array<{ text: string }>, _metadata?: unknown, target?: { forAgent?: string }) => {
          notes.push({ text: content.map((b) => b.text).join(''), ...(target?.forAgent !== undefined ? { forAgent: target.forAgent } : {}) });
        },
        getAgents: () => agents.map((name) => ({ name })),
      } as unknown as ModuleContext;
      const module = new TtsRelayModule({ url: 'ws://127.0.0.1:1/bot', token: 't' });
      const inner = module as unknown as {
        ctx: ModuleContext;
        onTraceEvent(event: Record<string, unknown>): void;
        handleInterruption(ev: Interruption): Promise<void>;
      };
      inner.ctx = ctx;
      const started = (agentName: string, channelId: string) => inner.onTraceEvent({ timestamp: 1, type: 'inference:started', agentName, channelId });
      const ended = (agentName: string) => inner.onTraceEvent({ timestamp: 1, type: 'inference:completed', agentName });
      const interrupt = () => inner.handleInterruption({ channelId: '42', spokenText: 'The ferry', reason: 'user_speech', timestamp: 2 });
      return { notes, started, ended, interrupt };
    }

    test('the agent whose activation is live in its channel, not the first agent the relay voiced', async () => {
      const { notes, started, interrupt } = relayOnActivations(['clerk', 'mira']);
      started('clerk', 'g:43');
      started('mira', 'g:42');
      await interrupt();
      expect(notes.map((n) => n.forAgent)).toEqual(['mira']);
    });

    test('the agent last voiced in its channel, once that activation has ended', async () => {
      const { notes, started, ended, interrupt } = relayOnActivations(['clerk', 'mira']);
      started('clerk', 'g:43');
      started('mira', 'g:42');
      ended('mira');
      await interrupt();
      expect(notes.map((n) => n.forAgent)).toEqual(['mira']);
    });

    test('none, and no note is written, when no agent was voiced in its channel', async () => {
      const { notes, started, interrupt } = relayOnActivations(['clerk', 'mira']);
      started('clerk', 'g:43');
      const logged = await logOf(interrupt);
      expect(notes).toEqual([]);
      expect(logged).toContain('the interruption in 42 is told to no agent: no published message matched it, and no agent was voiced in that channel');
    });

    test('none, and no note is written, when two agents are voicing in its channel', async () => {
      const { notes, started, interrupt } = relayOnActivations(['clerk', 'mira']);
      started('clerk', 'g:42');
      started('mira', 'g:42');
      const logged = await logOf(interrupt);
      expect(notes).toEqual([]);
      expect(logged).toContain('the interruption in 42 is told to no agent: no published message matched it, and clerk, mira are each voicing in that channel');
    });

    test('none, and no note is written, when the agent voiced there is no longer registered', async () => {
      const { notes, started, interrupt } = relayOnActivations(['clerk']);
      started('mira', 'g:42');
      const logged = await logOf(interrupt);
      expect(notes).toEqual([]);
      expect(logged).toContain('the interruption in 42 is told to no agent: mira, voicing in that channel, is no longer registered');
    });
  });
});

/** What `run` writes to console.error, one line per call. */
async function logOf(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines.join('\n');
}

/** The module on traces alone, with `agents` registered: what it edits, and
 *  the notes it writes, each with the agent it was written for. */
function relayOnTraces(agents: string[] = ['fable']) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const notes: Array<{ text: string; forAgent?: string }> = [];
  const ctx = {
    callTool: async (call: { name: string; input: unknown }) => { calls.push({ name: call.name, input: call.input }); return { success: true }; },
    addMessage: (_role: string, content: Array<{ text: string }>, _metadata?: unknown, target?: { forAgent?: string }) => {
      notes.push({ text: content.map((b) => b.text).join(''), ...(target?.forAgent !== undefined ? { forAgent: target.forAgent } : {}) });
    },
    getAgents: () => agents.map((name) => ({ name })),
  } as unknown as ModuleContext;
  const module = new TtsRelayModule({ url: 'ws://127.0.0.1:1/bot', token: 't' });
  const inner = module as unknown as {
    ctx: ModuleContext;
    onTraceEvent(event: Record<string, unknown>): void;
    handleInterruption(ev: Interruption): Promise<void>;
  };
  inner.ctx = ctx;
  const trace = (event: Record<string, unknown>) => inner.onTraceEvent({ timestamp: 1, ...event });
  const interrupt = (spokenText: string) => inner.handleInterruption({ channelId: '42', spokenText, reason: 'user_speech', timestamp: 2 });
  const edited = () => calls.map((c) => (c.input as { messageId: string }).messageId);
  return { trace, interrupt, edited, notes };
}

describe('what an interruption may edit', () => {

  test('heard words that start an announcement routed after a published message edit neither', async () => {
    const { trace, interrupt, edited } = relayOnTraces();
    trace({ type: 'inference:published', agentName: 'fable', serverId: 'discord', channelId: 'g:42', inferenceId: 'i1', index: 0, text: 'The ferry leaves at noon, and the bridge is closed.', messageId: 'm-prose' });
    trace({ type: 'mcpl:speech-routed', conversationId: 'fable', channelId: 'g:42', text: 'Going to sleep for an hour.', messageId: 'm-sleep' });
    await interrupt('Going to sleep');
    expect(edited()).toEqual([]);
  });

  test('the published message whose text the heard words start is edited, though a later one was published', async () => {
    const { trace, interrupt, edited } = relayOnTraces();
    trace({ type: 'inference:published', agentName: 'fable', serverId: 'discord', channelId: 'g:42', inferenceId: 'i1', index: 0, text: 'The ferry leaves at noon, and the bridge is closed.', messageId: 'm-first' });
    trace({ type: 'inference:published', agentName: 'fable', serverId: 'discord', channelId: 'g:42', inferenceId: 'i1', index: 1, text: 'Take the coast road instead.', messageId: 'm-second' });
    await interrupt('The ferry leaves at noon');
    expect(edited()).toEqual(['m-first']);
  });

  test('with only routed announcements in the channel, nothing is edited', async () => {
    const { trace, interrupt, edited } = relayOnTraces();
    trace({ type: 'mcpl:speech-routed', conversationId: 'fable', channelId: 'g:42', text: 'Going to sleep for an hour.', messageId: 'm-sleep' });
    await interrupt('Going to sleep');
    expect(edited()).toEqual([]);
  });
});

// The note goes to the author of the published message the heard words start,
// else to the agent voicing in the interruption's channel; a publish the words
// don't start is neither edited nor taken as the speaker.
describe('heard words that start no published message', () => {
  const published = { type: 'inference:published', agentName: 'clerk', serverId: 'discord', channelId: 'g:42', inferenceId: 'i1', index: 0, text: 'The ferry leaves at noon, and the bridge is closed.', messageId: 'm-clerk' };

  test('edit nothing, and the note is for the agent voicing in the channel, not the one that last published there', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace(published);
    trace({ type: 'inference:started', agentName: 'mira', channelId: 'g:42' });
    const logged = await logOf(() => interrupt('Over the hills and far away'));
    expect(edited()).toEqual([]);
    expect(notes.map((n) => n.forAgent)).toEqual(['mira']);
    expect(logged).toContain('no published message matched the interruption');
  });

  test('the agent voicing in the channel is told though the one that last published there is no longer registered', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['mira']);
    trace(published);
    trace({ type: 'inference:started', agentName: 'mira', channelId: 'g:42' });
    await interrupt('Over the hills and far away');
    expect(edited()).toEqual([]);
    expect(notes.map((n) => n.forAgent)).toEqual(['mira']);
  });

  test('the agent live in the channel is told over the one last voiced there', async () => {
    const { trace, interrupt, notes } = relayOnTraces(['clerk', 'mira']);
    trace(published);
    trace({ type: 'inference:started', agentName: 'mira', channelId: 'g:42' });
    trace({ type: 'inference:started', agentName: 'clerk', channelId: 'g:42' });
    trace({ type: 'inference:completed', agentName: 'clerk' });
    await interrupt('Over the hills and far away');
    expect(notes.map((n) => n.forAgent)).toEqual(['mira']);
  });

  test('heard words that start the publish still edit it and tell its author', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace(published);
    trace({ type: 'inference:started', agentName: 'mira', channelId: 'g:42' });
    await interrupt('The ferry leaves');
    expect(edited()).toEqual(['m-clerk']);
    expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
  });
});
