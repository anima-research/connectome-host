/**
 * TtsRelayModule's answer to an interruption: it edits the posted message down
 * to the voiced words, and tells the agent whether that edit went through.
 * From agent-framework 0.22.3 a module's `callTool` gets an MCPL server's error
 * result as a failure (`success: false`, `isError: true`, its text as `error`),
 * where it got one as a success, so a refused edit now reads as not trimmed.
 */
import { describe, expect, test } from 'bun:test';
import type { ModuleContext } from '@animalabs/agent-framework';
import { TtsRelayModule } from '../src/modules/tts-relay-module.js';

type Interruption = { channelId: string; spokenText: string; reason: 'user_speech' | 'manual' | 'timeout'; timestamp: number };

/** The module on a context whose callTool answers `answer`, with one published
 *  message posted to Discord channel 42, and the notes it gives the agent. */
function relayWith(answer: Record<string, unknown>) {
  const notes: string[] = [];
  const calls: Array<{ name: string; input: unknown }> = [];
  const ctx = {
    callTool: async (call: { name: string; input: unknown }) => { calls.push({ name: call.name, input: call.input }); return answer; },
    addMessage: (_role: string, content: Array<{ text: string }>) => { notes.push(content.map((b) => b.text).join('')); },
  } as unknown as ModuleContext;
  const module = new TtsRelayModule({ url: 'ws://127.0.0.1:1/bot', token: 't' });
  const inner = module as unknown as {
    ctx: ModuleContext;
    published: Array<{ rawChannelId: string; mcplChannelId: string; messageId?: string; text: string; at: number }>;
    handleInterruption(ev: Interruption): Promise<void>;
  };
  inner.ctx = ctx;
  inner.published.push({ rawChannelId: '42', mcplChannelId: 'discord:42', messageId: 'm-1', text: 'The ferry leaves at noon, and the bridge is closed.', at: 1 });
  const interrupt = () => inner.handleInterruption({ channelId: '42', spokenText: 'The ferry leaves at noon', reason: 'user_speech', timestamp: 2 });
  return { notes, calls, interrupt };
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

// The edit target is a message the agent's prose published, as
// agent-framework's `inference:published` reports it. agent-framework 0.24's
// notes say `mcpl:speech-routed` also reports the `sleep` tool's announcement
// and a subconscious's `speak_in_channel`, which an interruption must never
// edit.
describe('what an interruption may edit', () => {
  function relayOnTraces() {
    const calls: Array<{ name: string; input: unknown }> = [];
    const ctx = {
      callTool: async (call: { name: string; input: unknown }) => { calls.push({ name: call.name, input: call.input }); return { success: true }; },
      addMessage: () => {},
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
    return { trace, interrupt, edited };
  }

  test('a published message is edited, and an announcement routed after it is passed over', async () => {
    const { trace, interrupt, edited } = relayOnTraces();
    trace({ type: 'inference:published', agentName: 'fable', serverId: 'discord', channelId: 'g:42', inferenceId: 'i1', index: 0, text: 'The ferry leaves at noon, and the bridge is closed.', messageId: 'm-prose' });
    trace({ type: 'mcpl:speech-routed', conversationId: 'fable', channelId: 'g:42', text: 'Going to sleep for an hour.', messageId: 'm-sleep' });
    await interrupt('Something the words never matched');
    expect(edited()).toEqual(['m-prose']);
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
