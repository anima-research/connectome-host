/**
 * agent-framework hands a module's callTool an MCPL server's error result as a
 * failure: `success: false`, `isError: true`, its text as `error`.
 */
import { describe, expect, test } from 'bun:test';
import type { ModuleContext } from '@animalabs/agent-framework';
import { TtsRelayModule } from '../src/modules/tts-relay-module.js';

type Interruption = { channelId: string; spokenText: string; reason: 'user_speech' | 'manual' | 'timeout'; timestamp: number };

/** The module on a context whose callTool answers `answer`, with one published
 *  message posted to channel 42 of the server `editServerId` names (Discord
 *  by default) by `speaker`, and the notes it gives the agent, each with the
 *  agent it was written for. */
function relayWith(answer: Record<string, unknown>, opts: { agents?: string[]; speaker?: string; editServerId?: string } = {}) {
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
  const server = opts.editServerId ?? 'discord';
  const module = new TtsRelayModule({ url: 'ws://127.0.0.1:1/bot', token: 't', ...(opts.editServerId !== undefined ? { editServerId: opts.editServerId } : {}) });
  const inner = module as unknown as {
    ctx: ModuleContext;
    onTraceEvent(event: Record<string, unknown>): void;
    handleInterruption(ev: Interruption): Promise<void>;
  };
  inner.ctx = ctx;
  inner.onTraceEvent({ timestamp: 1, type: 'inference:published', agentName: opts.speaker ?? 'fable', serverId: server, channelId: `${server}:42`, inferenceId: 'i1', index: 0, text: 'The ferry leaves at noon, and the bridge is closed.', messageId: 'm-1' });
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

  test('with editServerId set, the edit goes to that server\'s edit_message', async () => {
    const { calls, interrupt } = relayWith({ success: true }, { editServerId: 'discord-main' });
    await interrupt();
    expect(calls.map((c) => c.name)).toEqual(['mcpl--discord-main--edit_message']);
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
  // read from the agents voiced there: the relay's own record of whose
  // activations it announced where, and whose messages it voiced where.
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

    // The relay voices a turn's messages after the turn has ended, so the
    // agent whose activation ended may still be the one heard when another
    // starts.
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

    // Host #485 bot review wave 4, finding 3: the interruption's reset left
    // out clerk's activation, live then, so once it ended and mira started,
    // mira was told, though the relay voices what clerk publishes after the
    // interruption too.
    test("none, and no note is written, when the agent live at the channel's previous interruption has ended there and another started since", async () => {
      const { notes, started, ended, interrupt } = relayOnActivations(['clerk', 'mira']);
      started('clerk', 'g:42');
      await interrupt();
      ended('clerk');
      started('mira', 'g:42');
      const logged = await logOf(() => interrupt());
      expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
      expect(logged).toContain('the interruption in 42 is told to no agent: no published message matched it, and clerk, mira were each voiced in that channel since its previous interruption');
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
 *  the notes it writes, each with the agent it was written for. With `link`,
 *  its relay client is one whose connection is up while `link.up` is true;
 *  without, it has none, as before start(). */
function relayOnTraces(agents: string[] = ['fable'], link?: { up: boolean }) {
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
    published: Map<string, unknown[]>;
    voicedIn: Map<string, { agents: Set<string> }>;
    client: { isConnected(): boolean; emit(type: string, payload: Record<string, unknown>): void } | null;
  };
  inner.ctx = ctx;
  if (link) inner.client = { isConnected: () => link.up, emit: () => {} };
  const trace = (event: Record<string, unknown>) => inner.onTraceEvent({ timestamp: 1, ...event });
  const interrupt = (spokenText: string, channelId = '42') => inner.handleInterruption({ channelId, spokenText, reason: 'user_speech', timestamp: 2 });
  const edited = () => calls.map((c) => (c.input as { messageId: string }).messageId);
  /** The channels the module keeps publishes in, and the voiced agents' names of. */
  const kept = {
    published: () => [...inner.published].filter(([, rows]) => rows.length > 0).map(([channel]) => channel),
    named: () => [...inner.voicedIn].filter(([, v]) => v.agents.size > 0).map(([channel]) => channel),
  };
  return { trace, interrupt, edited, notes, kept };
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

  // Heard words that start no published message edit nothing here, so the
  // message on the other server starts them too, and is newer.
  test('a message published to another server is passed over', async () => {
    const { trace, interrupt, edited } = relayOnTraces();
    trace({ type: 'inference:published', agentName: 'fable', serverId: 'discord', channelId: 'g:42', inferenceId: 'i1', index: 0, text: 'The ferry leaves at noon, and the bridge is closed.', messageId: 'm-prose' });
    trace({ type: 'inference:published', agentName: 'fable', serverId: 'zulip', channelId: 'zulip:stream:42', inferenceId: 'i1', index: 1, text: 'The ferry leaves at noon, and the bridge is open.', messageId: 'm-zulip' });
    await interrupt('The ferry leaves at noon');
    expect(edited()).toEqual(['m-prose']);
  });

  // A message with no words can't start any heard words, so what shows it
  // passed over is that it isn't kept as an edit target.
  test('a published message with no words is passed over', async () => {
    const { trace, interrupt, edited, kept } = relayOnTraces();
    trace({ type: 'inference:published', agentName: 'fable', serverId: 'discord', channelId: 'g:42', inferenceId: 'i1', index: 0, text: 'The ferry leaves at noon, and the bridge is closed.', messageId: 'm-prose' });
    trace({ type: 'inference:published', agentName: 'fable', serverId: 'discord', channelId: 'g:44', inferenceId: 'i1', index: 1, text: '\n \t\n', messageId: 'm-blank' });
    expect(kept.published()).toEqual(['42']);
    await interrupt('The ferry leaves at noon');
    expect(edited()).toEqual(['m-prose']);
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

  test('by two agents: the newest is edited, and no note is written', async () => {
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

  // Host #485 bot review wave 3, finding 25: the publishes were one ring of
  // 32 for every channel, so another channel's traffic pushed clerk's out,
  // and mira was told as the only author matched.
  test('by two agents with 33 publishes in another channel between them: the newest is edited, and no note is written', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace(publish('clerk', 'm-clerk', 'Yes, the ferry leaves at noon.'));
    for (let i = 0; i < 33; i++) {
      trace({ type: 'inference:published', agentName: 'mira', serverId: 'discord', channelId: 'g:43', inferenceId: `i-43-${i}`, index: 0, text: `Elsewhere ${i}.`, messageId: `m-43-${i}` });
    }
    trace(publish('mira', 'm-mira', 'Yes — and the bridge is closed.'));
    const logged = await logOf(() => interrupt('Yes'));
    expect(edited()).toEqual(['m-mira']);
    expect(notes).toEqual([]);
    expect(logged).toContain('the interruption in 42 is told to no agent: the heard words start messages published by clerk, mira');
  });

  test('sharing their first 80 characters: the one that shares more of the heard words is edited, though older, and no note is written', async () => {
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

// The relay client sends nothing while it isn't connected and
// authenticated, so a message published then is never voiced (host #485 bot
// review wave 6, finding 3). It was kept, counted and named as voiced all
// the same: heard words that started it and a voiced message by another
// agent named two authors, so no note was written, and on a tie the unvoiced
// message, the newer, was the one edited.
describe('a message published while the relay is disconnected', () => {
  const shared = 'The ferry leaves at noon from the north pier, and the old bridge on the coast is';
  const miraText = `${shared} closed until Friday for repairs to the deck and the railings.`;
  const clerkText = `${shared}, since this morning, open again to cars and to the buses.`;
  const publish = (agentName: string, messageId: string, text: string) =>
    ({ type: 'inference:published', agentName, serverId: 'discord', channelId: 'g:42', inferenceId: `i-${messageId}`, index: 0, text, messageId });

  test("isn't matched: heard words that start it and a message published once the relay is back edit that one and tell its author", async () => {
    const link = { up: false };
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira'], link);
    trace(publish('mira', 'm-mira', miraText));
    link.up = true;
    trace(publish('clerk', 'm-clerk', clerkText));
    await interrupt(clerkText.slice(0, 100));
    expect(edited()).toEqual(['m-clerk']);
    expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
  });

  test("isn't taken on a tie with the voiced message before it: that one is edited, and its author told", async () => {
    const link = { up: true };
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira'], link);
    trace(publish('clerk', 'm-clerk', clerkText));
    link.up = false;
    trace(publish('mira', 'm-mira', miraText));
    link.up = true;
    await interrupt(shared);
    expect(edited()).toEqual(['m-clerk']);
    expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
  });
});

// The note goes to the author of the published messages the heard words
// start, else to the agent voiced in the interruption's channel, when one
// agent can be named; otherwise no note is written. A publish the words
// don't start is never edited, and its author is told only as the one agent
// voiced in the channel.
describe('heard words that start no published message', () => {
  const published = { type: 'inference:published', agentName: 'clerk', serverId: 'discord', channelId: 'g:42', inferenceId: 'i1', index: 0, text: 'The ferry leaves at noon, and the bridge is closed.', messageId: 'm-clerk' };

  // Since #317 a message is voiced on the channel it was published to,
  // whatever channel its turn is on, so its author is voiced there.
  test('edit nothing, and no note is written, when the agent whose activation is live in the channel and one that published there were both voiced there', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace(published);
    trace({ type: 'inference:started', agentName: 'mira', channelId: 'g:42' });
    const logged = await logOf(() => interrupt('Over the hills and far away'));
    expect(edited()).toEqual([]);
    expect(notes).toEqual([]);
    expect(logged).toContain('no published message matched the interruption');
    expect(logged).toContain('the interruption in 42 is told to no agent: no published message matched it, and clerk, mira were each voiced in that channel');
  });

  test('edit nothing, and the note is for the agent that published there from a turn on another channel, when no other agent was voiced there', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace({ type: 'inference:started', agentName: 'clerk', channelId: 'g:43' });
    trace(published);
    trace({ type: 'inference:started', agentName: 'mira', channelId: 'g:44' });
    const logged = await logOf(() => interrupt('Over the hills and far away'));
    expect(edited()).toEqual([]);
    expect(logged).toContain('no published message matched the interruption');
    expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
  });

  test('none, and no note is written, when the one agent voiced there published from a turn on another channel and is no longer registered', async () => {
    const { trace, interrupt, notes } = relayOnTraces(['mira']);
    trace({ type: 'inference:started', agentName: 'clerk', channelId: 'g:43' });
    trace(published);
    const logged = await logOf(() => interrupt('Over the hills and far away'));
    expect(notes).toEqual([]);
    expect(logged).toContain('the interruption in 42 is told to no agent: clerk, voiced in that channel, is no longer registered');
  });

  test('none, and no note is written, when the agent live in the channel and one whose activation there ended were both voiced there', async () => {
    const { trace, interrupt, notes } = relayOnTraces(['clerk', 'mira']);
    trace(published);
    trace({ type: 'inference:started', agentName: 'mira', channelId: 'g:42' });
    trace({ type: 'inference:started', agentName: 'clerk', channelId: 'g:42' });
    trace({ type: 'inference:completed', agentName: 'clerk' });
    const logged = await logOf(() => interrupt('Over the hills and far away'));
    expect(notes).toEqual([]);
    expect(logged).toContain('the interruption in 42 is told to no agent: no published message matched it, and clerk, mira were each voiced in that channel');
  });

  test('heard words that start the publish still edit it and tell its author, when what another agent published there since doesn\'t start with them', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace(published);
    trace({ type: 'inference:started', agentName: 'mira', channelId: 'g:42' });
    trace({ type: 'inference:published', agentName: 'mira', serverId: 'discord', channelId: 'g:42', inferenceId: 'i2', index: 0, text: 'Over the hills.', messageId: 'm-mira' });
    await interrupt('The ferry leaves');
    expect(edited()).toEqual(['m-clerk']);
    expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
  });
});

// nissa's second reading of the #485 wave-2 answer, point 4: before the
// channel's first interruption, a fully voiced message by clerk stayed a
// candidate, so mira's reply, cut off with words that start clerk's
// message, had clerk's message trimmed and clerk told. Since #317 the
// relay voices only what was published, each message once its publish is
// confirmed, so mira's reply is voiced only as a message of its own, which
// the heard words start too. What an agent wrote and didn't publish (an
// explicit-mode aside, a held draft) isn't voiced, so it holds back nothing
// (host #485 bot review wave 5, findings 2 and 4).
describe("heard words that start a published message and what another agent wrote in the channel after it", () => {
  const clerkSaid = { type: 'inference:published', agentName: 'clerk', serverId: 'discord', channelId: 'g:42', inferenceId: 'i1', index: 0, text: 'Yes, the ferry leaves at noon.', messageId: 'm-clerk' };
  const write = (trace: (event: Record<string, unknown>) => void, agentName: string, text: string, end = true) => {
    trace({ type: 'inference:started', agentName, channelId: 'g:42' });
    trace({ type: 'inference:tokens', agentName, channelId: 'g:42', blockIndex: 0, blockType: 'text', content: text });
    if (end) trace({ type: 'inference:completed', agentName });
  };
  const publish = (agentName: string, text: string, messageId: string) =>
    ({ type: 'inference:published', agentName, serverId: 'discord', channelId: 'g:42', inferenceId: `i-${messageId}`, index: 0, text, messageId });

  test("unpublished, by an activation still live: the message is edited and its author told, before the channel's first interruption", async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    write(trace, 'clerk', 'Yes, the ferry leaves at noon.');
    trace(clerkSaid);
    write(trace, 'mira', 'Yes, the ferry is late today.', false);
    await interrupt('Yes, the ferry');
    expect(edited()).toEqual(['m-clerk']);
    expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
  });

  test('and after one, alike, by an activation that has ended', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    write(trace, 'clerk', 'Over the hills.');
    await interrupt('Over');
    write(trace, 'clerk', 'Yes, the ferry leaves at noon.');
    trace(clerkSaid);
    write(trace, 'mira', 'Yes, the ferry is late today.');
    await interrupt('Yes, the ferry');
    expect(edited()).toEqual(['m-clerk']);
    expect(notes.map((n) => n.forAgent)).toEqual(['clerk', 'clerk']);
  });

  // Wave 5, finding 4's case: mira's activation that wrote "Yes" ended
  // unposted, and her next is live writing "No".
  test('unpublished, by an ended activation and a live one after it: the message is edited and its author told', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace(clerkSaid);
    write(trace, 'mira', 'Yes, the ferry is late today.');
    write(trace, 'mira', 'No, it left early.', false);
    await interrupt('Yes, the ferry');
    expect(edited()).toEqual(['m-clerk']);
    expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
  });

  test('published after it: the newer message is edited, and no note is written', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace(clerkSaid);
    trace(publish('mira', 'Yes, the ferry is late today.', 'm-mira'));
    const logged = await logOf(() => interrupt('Yes, the ferry'));
    expect(edited()).toEqual(['m-mira']);
    expect(notes).toEqual([]);
    expect(logged).toContain('the interruption in 42 is told to no agent: the heard words start messages published by clerk, mira');
  });

  // Wave 5, finding 2's case: mira's activation, announced before clerk's
  // message and live across the channel's interruption, goes on to publish
  // the same opening after it.
  test('published after it by an activation announced before it, live across an interruption: the newer message is edited, and no note is written', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    trace({ type: 'inference:started', agentName: 'mira', channelId: 'g:42' });
    await interrupt('');
    trace(clerkSaid);
    trace(publish('mira', 'Yes, the ferry is late today.', 'm-mira'));
    const logged = await logOf(() => interrupt('Yes, the ferry'));
    expect(edited()).toEqual(['m-mira']);
    expect(notes.map((n) => n.forAgent)).toEqual(['mira']);
    expect(logged).toContain('the interruption in 42 is told to no agent: the heard words start messages published by clerk, mira');
  });
});

// Host #485 bot review wave 4, finding 14: each channel kept its latest 32
// publishes and each agent's latest activation text, for every channel
// spoken in since its last interruption, so a resident's footprint grew
// with every channel it spoke in. The texts are kept for the 32 channels
// published in last, a publish being what the relay voices (#317); a
// channel's agents' names are kept whatever, since a channel's entry let go
// whole would name only an agent voiced there after it (host #485 bot
// review wave 2, finding 18).
describe('the texts kept to match an interruption', () => {
  const speak = (trace: (event: Record<string, unknown>) => void, agentName: string, channel: string, text: string, messageId: string) => {
    trace({ type: 'inference:started', agentName, channelId: `g:${channel}` });
    trace({ type: 'inference:tokens', agentName, channelId: `g:${channel}`, blockIndex: 0, blockType: 'text', content: text });
    trace({ type: 'inference:published', agentName, serverId: 'discord', channelId: `g:${channel}`, inferenceId: `i-${messageId}`, index: 0, text, messageId });
    trace({ type: 'inference:completed', agentName });
  };

  test('are those of the 32 channels published in last, however many channels are published in, and every channel keeps the names of the agents voiced there', () => {
    const { trace, kept } = relayOnTraces(['clerk', 'mira']);
    for (let i = 0; i < 100; i++) speak(trace, i % 2 ? 'mira' : 'clerk', String(100 + i), `Reply ${i}.`, `m-${i}`);
    const last32 = Array.from({ length: 32 }, (_, i) => String(168 + i));
    expect(kept.published().sort()).toEqual(last32);
    expect(kept.named()).toHaveLength(100);
  });

  test('of a channel published in before those are let go: its interruption edits nothing, and its note is for the agent voiced there', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    speak(trace, 'clerk', '42', 'Yes, the ferry leaves at noon.', 'm-clerk');
    for (let i = 0; i < 32; i++) speak(trace, 'mira', String(100 + i), `Elsewhere ${i}.`, `m-${i}`);
    const logged = await logOf(() => interrupt('Yes, the ferry'));
    expect(edited()).toEqual([]);
    expect(logged).toContain('no published message matched the interruption');
    expect(notes).toEqual([{ text: '[voice] Your reply was interrupted by user speech after: "Yes, the ferry" (the posted message could not be trimmed)', forAgent: 'clerk' }]);
  });

  // Host #485 bot review wave 5, finding 7: this test published in 42 once,
  // then in 31 other channels, so 42 was the oldest of 32 and kept whether
  // or not a publish moves its channel to the end.
  test("of a channel published in again are kept: its later publish is still edited once 32 others are published in, and the one published in longest ago is let go", async () => {
    const { trace, interrupt, edited, notes, kept } = relayOnTraces(['clerk', 'mira']);
    speak(trace, 'clerk', '42', 'Over the hills.', 'm-clerk-1');
    for (let i = 0; i < 31; i++) speak(trace, 'mira', String(100 + i), `Elsewhere ${i}.`, `m-${i}`);
    speak(trace, 'clerk', '42', 'Yes, the ferry leaves at noon.', 'm-clerk-2');
    speak(trace, 'mira', '200', 'One channel more.', 'm-200');
    expect(kept.published()).toContain('42');
    expect(kept.published()).not.toContain('100');
    await interrupt('Yes, the ferry');
    expect(edited()).toEqual(['m-clerk-2']);
    expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
  });

  // Host #485 bot review wave 5, finding 3 (a regression from 514e503): a
  // channel whose texts were let go and then published in again held only
  // the new publish, so heard words that started it and mira's message let
  // go were taken as clerk's alone: clerk's message was edited and clerk
  // told. Before 514e503 mira's message was still kept, so no note was
  // written, and the one sharing more of the heard words was edited.
  describe('of a channel let go and published in again, by another agent than one voiced there before', () => {
    const shared = 'The ferry leaves at noon from the north pier, and the old bridge on the coast is';
    const miraText = `${shared} closed until Friday for repairs to the deck and the railings.`;
    const clerkText = `${shared}, since this morning, open again to cars and to the buses.`;
    const letGoThenClerk = (trace: (event: Record<string, unknown>) => void) => {
      speak(trace, 'mira', '42', miraText, 'm-mira');
      for (let i = 0; i < 32; i++) speak(trace, 'mira', String(100 + i), `Elsewhere ${i}.`, `m-${i}`);
      speak(trace, 'clerk', '42', clerkText, 'm-clerk');
    };

    test("heard words that start mira's message let go and clerk's: clerk's isn't edited, and no note is written", async () => {
      const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
      letGoThenClerk(trace);
      await logOf(() => interrupt(miraText.slice(0, 100)));
      expect(edited()).not.toContain('m-clerk');
      expect(notes).toEqual([]);
    });

    // Stricter than before 514e503, which edited clerk's message, the newer
    // of two that the heard words start alike: with mira's let go, which of
    // the two was heard can't be told.
    test("heard words that start clerk's message alone of those kept: nothing is edited, and no note is written", async () => {
      const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
      letGoThenClerk(trace);
      const logged = await logOf(() => interrupt(shared));
      expect(edited()).toEqual([]);
      expect(notes).toEqual([]);
      expect(logged).toContain('the heard words start m-clerk, and messages mira published in 42 are no longer kept — nothing edited');
      expect(logged).toContain('the interruption in 42 is told to no agent: the heard words start a message published by clerk, and messages mira published in that channel are no longer kept');
    });

    test('heard words that start a later message by the one agent whose messages were let go there still edit it and tell its author', async () => {
      const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
      speak(trace, 'clerk', '42', miraText, 'm-clerk-1');
      for (let i = 0; i < 32; i++) speak(trace, 'mira', String(100 + i), `Elsewhere ${i}.`, `m-${i}`);
      speak(trace, 'clerk', '42', clerkText, 'm-clerk-2');
      await interrupt(shared);
      expect(edited()).toEqual(['m-clerk-2']);
      expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
    });

    // Since #317 an activation voices nothing until its agent publishes.
    test("an agent whose activation alone was announced there doesn't hold the match back", async () => {
      const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
      trace({ type: 'inference:started', agentName: 'mira', channelId: 'g:42' });
      trace({ type: 'inference:completed', agentName: 'mira' });
      speak(trace, 'clerk', '42', miraText, 'm-clerk-1');
      for (let i = 0; i < 32; i++) speak(trace, 'mira', String(100 + i), `Elsewhere ${i}.`, `m-${i}`);
      speak(trace, 'clerk', '42', clerkText, 'm-clerk-2');
      await interrupt(shared);
      expect(edited()).toEqual(['m-clerk-2']);
      expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
    });

    test('after its next interruption, a message published there is edited and its author told', async () => {
      const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
      letGoThenClerk(trace);
      await logOf(() => interrupt(shared));
      speak(trace, 'clerk', '42', clerkText, 'm-clerk-2');
      await interrupt(shared);
      expect(edited()).toEqual(['m-clerk-2']);
      expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
    });
  });

  // An activation that ends without publishing voiced nothing, so it keeps
  // no channel's texts and pushes out none (host #485 bot review wave 5,
  // finding 36).
  test('are not pushed out by channels where an activation only ended', async () => {
    const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
    speak(trace, 'clerk', '42', 'Yes, the ferry leaves at noon.', 'm-clerk');
    for (let i = 0; i < 32; i++) {
      trace({ type: 'inference:started', agentName: 'mira', channelId: `g:${100 + i}` });
      trace({ type: 'inference:completed', agentName: 'mira' });
    }
    await interrupt('Yes, the ferry');
    expect(edited()).toEqual(['m-clerk']);
    expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
  });

  // Within a channel kept, its latest 32 publishes are kept. Of 33 in one
  // channel the first is let go; the verifier's plant (no channel.shift(),
  // so every publish kept) left the suite green.
  describe('of a channel published in 33 times', () => {
    const publish33 = (trace: (event: Record<string, unknown>) => void) => {
      for (let i = 0; i < 33; i++) speak(trace, 'clerk', '42', `Ferry notice ${i}: the boat leaves at noon.`, `m-${i}`);
    };

    test('heard words that start the first edit nothing, and the note is for the agent voiced there', async () => {
      const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
      publish33(trace);
      const logged = await logOf(() => interrupt('Ferry notice 0: the boat'));
      expect(edited()).toEqual([]);
      expect(logged).toContain('no published message matched the interruption');
      expect(notes).toEqual([{ text: '[voice] Your reply was interrupted by user speech after: "Ferry notice 0: the boat" (the posted message could not be trimmed)', forAgent: 'clerk' }]);
    });

    test('heard words that start the second, the oldest of the 32 kept, edit it', async () => {
      const { trace, interrupt, edited, notes } = relayOnTraces(['clerk', 'mira']);
      publish33(trace);
      await interrupt('Ferry notice 1: the boat');
      expect(edited()).toEqual(['m-1']);
      expect(notes.map((n) => n.forAgent)).toEqual(['clerk']);
    });
  });
});
