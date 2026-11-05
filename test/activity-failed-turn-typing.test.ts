import { describe, expect, test } from 'bun:test';
import type { ModuleContext, TraceEvent } from '@animalabs/agent-framework';
import { ActivityModule } from '../src/modules/activity-module.js';

describe('typing lifecycle', () => {
  test('a failed or exhausted turn stops the indicator like a completed one', async () => {
    const typing: string[] = [];
    let listener: ((e: TraceEvent) => void) | null = null;
    const framework = {
      onTrace: (cb: (e: TraceEvent) => void) => { listener = cb; return () => {}; },
      channels: {
        startTyping: (ch: string) => { typing.push(`start:${ch}`); },
        stopTyping: (ch?: string) => { typing.push(`stop:${ch ?? '*'}`); },
      },
    };
    const module = new ActivityModule({ initialChannels: ['zulip:ops', 'zulip:other'] });
    const ctx = { getState: () => null, setState: () => {}, getModule: () => undefined } as unknown as ModuleContext;
    await module.start(ctx);
    module.setFramework(framework as never);
    const emit = (e: Record<string, unknown>) => listener!(e as unknown as TraceEvent);
    const startedThenStoppedBy = (end: Record<string, unknown>) => {
      const from = typing.length;
      emit({ type: 'inference:started' });
      const ending = typing.length;
      emit(end);
      return ['zulip:ops', 'zulip:other'].every((ch) =>
        typing.slice(from, ending).includes(`start:${ch}`) && typing.slice(ending).some((t) => t === `stop:${ch}` || t === 'stop:*'));
    };
    expect(startedThenStoppedBy({ type: 'inference:failed' })).toBe(true);
    expect(startedThenStoppedBy({ type: 'inference:exhausted' })).toBe(true);
  });
});
