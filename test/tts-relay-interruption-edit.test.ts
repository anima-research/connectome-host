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

/** The module on a context whose callTool answers `answer`, with one routed
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
    routed: Array<{ rawChannelId: string; mcplChannelId: string; messageId?: string; text: string; at: number }>;
    handleInterruption(ev: Interruption): Promise<void>;
  };
  inner.ctx = ctx;
  inner.routed.push({ rawChannelId: '42', mcplChannelId: 'discord:42', messageId: 'm-1', text: 'The ferry leaves at noon, and the bridge is closed.', at: 1 });
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
