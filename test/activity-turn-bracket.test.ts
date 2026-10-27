import { describe, expect, test } from 'bun:test';
import type { ModuleContext, ToolCall, TraceEvent } from '@animalabs/agent-framework';
import { ActivityModule } from '../src/modules/activity-module.js';

function fakeFramework(typing: string[]) {
  const listeners = new Set<(e: TraceEvent) => void>();
  return {
    framework: {
      onTrace: (cb: (e: TraceEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      channels: {
        startTyping: (ch: string) => { typing.push(`start:${ch}`); },
        stopTyping: (ch?: string) => { typing.push(`stop:${ch ?? '*'}`); },
      },
    },
    emit: (type: string, extra: Record<string, unknown> = {}) => {
      for (const l of [...listeners]) l({ type, agentName: 'clerk', ...extra } as unknown as TraceEvent);
    },
    listening: () => listeners.size,
  };
}

async function setUp() {
  const typing: string[] = [];
  const fw = fakeFramework(typing);
  const module = new ActivityModule({ initialChannels: ['zulip:ops'] });
  const ctx = { getState: () => null, setState: () => {}, getModule: () => undefined } as unknown as ModuleContext;
  await module.start(ctx);
  module.setFramework(fw.framework as never);
  const showIn = (channel: string) =>
    module.handleToolCall({ id: `show-${channel}`, name: 'show_in', input: { channel }, callerAgentName: 'clerk' } as ToolCall);
  return { module, typing, fw, showIn };
}

describe('the turn flag', () => {
  for (const end of ['inference:completed', 'inference:turn_ended', 'inference:aborted', 'inference:failed', 'inference:exhausted']) {
    test(`${end} ends the turn, so show_in no longer starts typing`, async () => {
      const { typing, fw, showIn } = await setUp();
      fw.emit('inference:started');
      fw.emit(end);
      expect(typing).toEqual(['start:zulip:ops', 'stop:zulip:ops']);
      await showIn('zulip:later');
      expect(typing).toEqual(['start:zulip:ops', 'stop:zulip:ops']);
    });
  }

  test('show_in during a turn starts typing in the new channel', async () => {
    const { typing, fw, showIn } = await setUp();
    fw.emit('inference:started');
    await showIn('zulip:later');
    expect(typing).toEqual(['start:zulip:ops', 'start:zulip:later']);
  });

  test('a silent start shows nothing and sets no turn', async () => {
    const { typing, fw, showIn } = await setUp();
    fw.emit('inference:started', { silent: true });
    await showIn('zulip:later');
    expect(typing).toEqual([]);
    fw.emit('inference:started');
    expect(typing).toEqual(['start:zulip:ops', 'start:zulip:later']);
  });

  test('a silent start during a turn leaves that turn showing', async () => {
    const { typing, fw, showIn } = await setUp();
    fw.emit('inference:started');
    fw.emit('inference:started', { silent: true });
    await showIn('zulip:later');
    expect(typing).toEqual(['start:zulip:ops', 'start:zulip:later']);
  });

  test("stop() stops typing and ends the module's subscription", async () => {
    const { module, typing, fw } = await setUp();
    fw.emit('inference:started');
    await module.stop();
    expect(fw.listening()).toBe(0);
    expect(typing).toEqual(['start:zulip:ops', 'stop:zulip:ops']);
  });

  test("a framework handed over replaces the old one's subscription and typing, and starts with no turn", async () => {
    const { module, typing, fw, showIn } = await setUp();
    fw.emit('inference:started');
    const nextTyping: string[] = [];
    const next = fakeFramework(nextTyping);
    module.setFramework(next.framework as never);
    expect(fw.listening()).toBe(0);
    expect(next.listening()).toBe(1);
    expect(typing).toEqual(['start:zulip:ops', 'stop:zulip:ops']);
    await showIn('zulip:later');
    expect(nextTyping).toEqual([]);
    next.emit('inference:started');
    expect(nextTyping).toEqual(['start:zulip:ops', 'start:zulip:later']);
  });
});
