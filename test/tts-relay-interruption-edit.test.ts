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
      const interrupt = (spokenText = 'The ferry') => inner.handleInterruption({ channelId: '42', spokenText, reason: 'user_speech', timestamp: 2 });
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
      expect(logged).toContain('the interruption in 42 is told to no agent: no published message matched it, and clerk, mira were each voiced in that channel');
    });

    // The relay voices a turn's chunks after the turn has ended, so the agent
    // whose activation ended may still be the one heard when another starts.
    test('none, and no note is written, when the heard words are empty and both the agent whose activation ended and the one started after it were voiced in its channel', async () => {
      const { notes, started, ended, interrupt } = relayOnActivations(['clerk', 'mira']);
      started('clerk', 'g:42');
      ended('clerk');
      started('mira', 'g:42');
      const logged = await logOf(() => interrupt(''));
      expect(notes).toEqual([]);
      expect(logged).toContain('no published message matched the interruption');
      expect(logged).toContain('the interruption in 42 is told to no agent: no published message matched it, and clerk, mira were each voiced in that channel');
    });

    test('the agent voiced in its channel since its previous interruption, not one voiced only before it', async () => {
      const { notes, started, ended, interrupt } = relayOnActivations(['clerk', 'mira']);
      started('clerk', 'g:42');
      ended('clerk');
      await interrupt();
      started('mira', 'g:42');
      ended('mira');
      await interrupt();
      const logged = await logOf(() => interrupt());
      expect(notes.map((n) => n.forAgent)).toEqual(['clerk', 'mira']);
      expect(logged).toContain('the interruption in 42 is told to no agent: no published message matched it, and no agent was voiced in that channel since its previous interruption');
    });

    // Each channel's voiced agents are kept however many channels the relay
    // voices in: one let go would leave only those voiced there after it.
    test('none, and no note is written, when the agent whose activation ended and the one started after it were voiced in its channel, with 32 other channels voiced in between', async () => {
      const { notes, started, ended, interrupt } = relayOnActivations(['clerk', 'mira']);
      started('clerk', 'g:42');
      ended('clerk');
      for (let i = 0; i < 32; i++) {
        started('mira', `g:${100 + i}`);
        ended('mira');
      }
      started('mira', 'g:42');
      const logged = await logOf(interrupt);
      expect(notes).toEqual([]);
      expect(logged).toContain('the interruption in 42 is told to no agent: no published message matched it, and clerk, mira were each voiced in that channel');
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
  const interrupt = (spokenText: string, channelId = '42') => inner.handleInterruption({ channelId, spokenText, reason: 'user_speech', timestamp: 2 });
  const edited = () => calls.map((c) => (c.input as { messageId: string }).messageId);
  return { trace, interrupt, edited, notes };
}

describe('what an interruption may edit', () => {

  test('heard words that start an announcement routed after a published message edit neither', async () => {
    const { trace, interrupt, edited } = relayOnTraces();
    trace({ type: 'inference:published', agentName: 'fable', serverId: 'discord', channelId: 'g:42', inferenceId: 'i1', index: 0, text: 'The ferry leaves at noon, and the bridge is closed.', messageId: 'm-prose' });
    trace({ type: 'mcpl:speech-routed', conversationId: 'fable', channelId: 'g:42', text: 'Going to sleep for an hour.', messageId: 'm-sleep' });
    const logged = await logOf(() => interrupt('Going to sleep'));
    expect(edited()).toEqual([]);
    expect(logged).toContain('no published message matched the interruption');
  });

  test('heard words that start a published message edit it, though an announcement was routed after it', async () => {
    const { trace, interrupt, edited } = relayOnTraces();
    trace({ type: 'inference:published', agentName: 'fable', serverId: 'discord', channelId: 'g:42', inferenceId: 'i1', index: 0, text: 'The ferry leaves at noon, and the bridge is closed.', messageId: 'm-prose' });
    trace({ type: 'mcpl:speech-routed', conversationId: 'fable', channelId: 'g:42', text: 'Going to sleep for an hour.', messageId: 'm-sleep' });
    await interrupt('The ferry leaves');
    expect(edited()).toEqual(['m-prose']);
  });

  // An interruption ends its channel's voicing, so what was published there
  // before it is not heard in a later one.
  test('a message published before the channel\'s previous interruption is not edited again, and the note is for the agent voiced since', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace({ type: 'inference:published', agentName: 'clerk', serverId: 'discord', channelId: 'g:42', inferenceId: 'i1', index: 0, text: 'Yes, the ferry leaves at noon.', messageId: 'm-clerk' });
    await interrupt('Yes, the ferry');
    trace({ type: 'inference:started', agentName: 'mira', channelId: 'g:42' });
    const logged = await logOf(() => interrupt('Yes, the ferry'));
    expect(edited()).toEqual(['m-clerk']);
    expect(logged).toContain('no published message matched the interruption');
    expect(notes.map((n) => n.forAgent)).toEqual(['clerk', 'mira']);
  });

  test('a message published in another channel is still edited after an interruption in this one', async () => {
    const { trace, interrupt, edited } = relayOnTraces();
    trace({ type: 'inference:published', agentName: 'fable', serverId: 'discord', channelId: 'g:43', inferenceId: 'i1', index: 0, text: 'Yes, the ferry leaves at noon.', messageId: 'm-43' });
    await interrupt('Yes, the ferry');
    await interrupt('Yes, the ferry', '43');
    expect(edited()).toEqual(['m-43']);
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
    const logged = await logOf(() => interrupt('Going to sleep'));
    expect(edited()).toEqual([]);
    expect(logged).toContain('no published message matched the interruption');
  });
});

// The heard words are matched on their first 80 characters (after runs of
// white space are made one space), so they can start more than one publish.
describe('heard words that start more than one published message', () => {
  const publish = (agentName: string, messageId: string, text: string) =>
    ({ type: 'inference:published', agentName, serverId: 'discord', channelId: 'g:42', inferenceId: `i-${messageId}`, index: 0, text, messageId });

  test('by two agents: the newest is edited, and the note is for no agent', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace(publish('clerk', 'm-clerk', 'Yes, the ferry leaves at noon.'));
    trace(publish('mira', 'm-mira', 'Yes — and the bridge is closed.'));
    const logged = await logOf(() => interrupt('Yes'));
    expect(edited()).toEqual(['m-mira']);
    expect(notes).toEqual([]);
    expect(logged).toContain('the interruption in 42 is told to no agent: the heard words start messages published by clerk, mira');
  });

  test('by one agent: the newest is edited, and the note is for that agent', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace(publish('clerk', 'm-1', 'Yes, the ferry leaves at noon.'));
    trace(publish('clerk', 'm-2', 'Yes — and the bridge is closed.'));
    await interrupt('Yes');
    expect(edited()).toEqual(['m-2']);
    expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
  });

  test('sharing their first 80 characters: the one that shares more of the heard words is edited, though older, and the note is for no agent', async () => {
    const shared = 'The ferry leaves at noon from the north pier, and the old bridge on the coast is';
    expect(shared).toHaveLength(80);
    const older = `${shared} closed until Friday for repairs to the deck and the railings.`;
    const newer = `${shared}, since this morning, open again to cars and to the buses.`;
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace(publish('clerk', 'm-older', older));
    trace(publish('mira', 'm-newer', newer));
    const logged = await logOf(() => interrupt(older.slice(0, 100)));
    expect(edited()).toEqual(['m-older']);
    expect(notes).toEqual([]);
    expect(logged).toContain('the interruption in 42 is told to no agent: the heard words start messages published by clerk, mira');
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
    const logged = await logOf(() => interrupt('Over the hills and far away'));
    expect(edited()).toEqual([]);
    expect(logged).toContain('no published message matched the interruption');
    expect(notes.map((n) => n.forAgent)).toEqual(['mira']);
  });

  test('none, and no note is written, when the agent live in the channel and one whose activation there ended were both voiced there', async () => {
    const { trace, interrupt, notes } = relayOnTraces(['clerk', 'mira']);
    trace(published);
    trace({ type: 'inference:started', agentName: 'mira', channelId: 'g:42' });
    trace({ type: 'inference:started', agentName: 'clerk', channelId: 'g:42' });
    trace({ type: 'inference:completed', agentName: 'clerk' });
    const logged = await logOf(() => interrupt('Over the hills and far away'));
    expect(notes).toEqual([]);
    expect(logged).toContain('the interruption in 42 is told to no agent: no published message matched it, and mira, clerk were each voiced in that channel');
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
