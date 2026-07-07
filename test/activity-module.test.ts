/**
 * ActivityModule typing-indicator lifecycle (fragility audit, activity
 * finding): the indicator must clear on EVERY terminal inference outcome,
 * not just inference:completed — otherwise a failed/exhausted retry chain
 * leaves the bot "typing" in every subscribed channel for hours.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { ActivityModule } from '../src/modules/activity-module.js';
import type { AgentFramework, ModuleContext, TraceEvent } from '@animalabs/agent-framework';

type TraceHandler = (event: TraceEvent) => void;

function makeHarness() {
  const startCalls: string[] = [];
  const stopCalls: string[] = [];
  const handlers: TraceHandler[] = [];

  const framework = {
    onTrace: (h: TraceHandler) => { handlers.push(h); },
    channels: {
      startTyping: (ch: string) => { startCalls.push(ch); },
      stopTyping: (ch: string) => { stopCalls.push(ch); },
    },
  } as unknown as AgentFramework;

  const ctx = {
    getState: <T>(): T | null => null,
    setState: (): void => { /* noop */ },
  } as unknown as ModuleContext;

  const emit = (event: { type: string; [k: string]: unknown }): void => {
    for (const h of handlers) h(event as unknown as TraceEvent);
  };

  return { framework, ctx, emit, startCalls, stopCalls };
}

describe('ActivityModule typing lifecycle', () => {
  let h: ReturnType<typeof makeHarness>;
  let mod: ActivityModule;

  beforeEach(async () => {
    h = makeHarness();
    mod = new ActivityModule({ initialChannels: ['zulip:tracker'] });
    await mod.start(h.ctx);
    mod.setFramework(h.framework);
  });

  test('inference:started starts typing; inference:completed stops it', () => {
    h.emit({ type: 'inference:started', agentName: 'a' });
    expect(h.startCalls).toEqual(['zulip:tracker']);
    h.emit({ type: 'inference:completed', agentName: 'a' });
    expect(h.stopCalls).toEqual(['zulip:tracker']);
  });

  test('inference:failed stops typing (previously stuck forever)', () => {
    h.emit({ type: 'inference:started', agentName: 'a' });
    h.emit({ type: 'inference:failed', agentName: 'a', error: 'boom' });
    expect(h.stopCalls).toEqual(['zulip:tracker']);
  });

  test('inference:exhausted stops typing', () => {
    h.emit({ type: 'inference:started', agentName: 'a' });
    h.emit({ type: 'inference:exhausted', agentName: 'a' });
    expect(h.stopCalls).toEqual(['zulip:tracker']);
  });

  test('inference:aborted stops typing', () => {
    h.emit({ type: 'inference:started', agentName: 'a' });
    h.emit({ type: 'inference:aborted', agentName: 'a' });
    expect(h.stopCalls).toEqual(['zulip:tracker']);
  });
});
