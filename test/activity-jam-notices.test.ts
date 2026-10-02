/**
 * ActivityModule: typing stops on a failed/exhausted turn, and (opt-in) a
 * subscribed channel that receives traffic while the host is jammed gets one
 * host-attributed notice per episode plus one "back" line on the clear.
 */
import { describe, expect, test } from 'bun:test';
import type { ModuleContext, TraceEvent } from '@animalabs/agent-framework';
import { ActivityModule, jamNoticeText, jamClearText } from '../src/modules/activity-module.js';

function harness(opts: { jamNotices?: boolean; now?: () => number } = {}) {
  const typing: string[] = [];
  const posts: Array<{ channelId: string; text: string; agentName: string }> = [];
  const markers: string[] = [];
  let listener: ((e: TraceEvent) => void) | null = null;
  const framework = {
    onTrace: (cb: (e: TraceEvent) => void) => { listener = cb; return () => {}; },
    channels: {
      startTyping: (ch: string) => { typing.push(`start:${ch}`); },
      stopTyping: (ch?: string) => { typing.push(`stop:${ch ?? '*'}`); },
      publishForAgent: async (channelId: string, text: string, agentName: string) => {
        posts.push({ channelId, text, agentName });
        return { success: !channelId.includes('broken'), error: channelId.includes('broken') ? 'nope' : undefined };
      },
    },
    getAgent: () => ({ getContextManager: () => ({ addMessage: (_p: string, content: Array<{ text: string }>) => { markers.push(content[0]!.text); return 'id'; } }) }),
  };
  const module = new ActivityModule({
    initialChannels: ['zulip:ops', 'zulip:broken'],
    jamNotices: opts.jamNotices ?? true,
    agentName: 'clerk',
    now: opts.now,
  });
  const ctx = { getState: () => null, setState: () => {}, getModule: () => undefined } as unknown as ModuleContext;
  const emit = (e: Record<string, unknown>) => listener!(e as unknown as TraceEvent);
  const incoming = (channelId: string) => module.onProcess({ type: 'mcpl:channel-incoming', channelId } as never, {} as never);
  return { module, framework, ctx, emit, incoming, typing, posts, markers };
}

describe('typing lifecycle', () => {
  test('a failed or exhausted turn stops the indicator like a completed one', async () => {
    const h = harness();
    await h.module.start(h.ctx);
    h.module.setFramework(h.framework as never);
    h.emit({ type: 'inference:started' });
    h.emit({ type: 'inference:failed' });
    expect(h.typing).toEqual(['start:zulip:ops', 'start:zulip:broken', 'stop:zulip:ops', 'stop:zulip:broken']);
    h.emit({ type: 'inference:started' });
    h.emit({ type: 'inference:exhausted' });
    expect(h.typing.filter((t) => t.startsWith('stop')).length).toBe(4);
  });
});

describe('jam notices', () => {
  test('a jam alert + incoming traffic posts once per channel, writes one marker, and the clear posts "back"', async () => {
    let t = 0;
    const h = harness({ now: () => t });
    await h.module.start(h.ctx);
    h.module.setFramework(h.framework as never);
    await h.incoming('zulip:ops');
    expect(h.posts).toEqual([]);
    h.emit({ type: 'ops:alert', kind: 'quota-spent', agentName: 'clerk', message: 'anthropic subscription quota spent (weekly)', data: { until: 7_200_000 } });
    expect(h.module.jamState()).toMatchObject({ kind: 'quota-spent', until: 7_200_000, notified: [] });
    await h.incoming('zulip:ops');
    await h.incoming('zulip:ops');
    await h.incoming('zulip:other'); // not subscribed
    expect(h.posts.length).toBe(1);
    expect(h.posts[0]).toMatchObject({ channelId: 'zulip:ops', agentName: 'clerk' });
    expect(h.posts[0]!.text).toBe(jamNoticeText('clerk', { kind: 'quota-spent', message: '', until: 7_200_000 }));
    expect(h.posts[0]!.text).toContain('subscription quota is spent');
    expect(h.posts[0]!.text).toContain('Expected back after 1970-01-01 02:00 UTC');
    expect(h.markers.length).toBe(1);
    expect(h.markers[0]).toContain('[host-notice]');
    h.emit({ type: 'ops:alert', kind: 'quota-spent-clear', agentName: 'clerk', message: 'anthropic credential ok' });
    expect(h.module.jamState()).toBeNull();
    expect(h.posts.length).toBe(2);
    expect(h.posts[1]!.text).toBe(jamClearText('clerk'));
    expect(h.posts[1]!.channelId).toBe('zulip:ops');
  });

  test('a failed post is retried on the next message; a superseding clear posts no "back"', async () => {
    const h = harness();
    await h.module.start(h.ctx);
    h.module.setFramework(h.framework as never);
    h.emit({ type: 'ops:alert', kind: 'auth-expiring', agentName: 'clerk', message: 'expires soon' });
    await h.incoming('zulip:broken');
    expect(h.posts.length).toBe(0); // auth-expiring is not a jam
    h.emit({ type: 'ops:alert', kind: 'auth-expired', agentName: 'clerk', message: 'expired' });
    await h.incoming('zulip:broken');
    await h.incoming('zulip:broken');
    expect(h.posts.length).toBe(2); // both attempts failed ⇒ both retried
    expect(h.module.jamState()!.notified).toEqual([]);
    h.emit({ type: 'ops:alert', kind: 'auth-expired-clear', agentName: 'clerk', message: 'superseded by auth-login-required' });
    expect(h.module.jamState()).toBeNull();
    expect(h.posts.length).toBe(2);
  });

  test('re-notifies only after an ANNOUNCED end has passed and the renotify window elapsed', async () => {
    let t = 0;
    const h = harness({ now: () => t });
    await h.module.start(h.ctx);
    h.module.setFramework(h.framework as never);
    h.emit({ type: 'ops:alert', kind: 'quota-spent', agentName: 'clerk', message: 'spent', data: { until: 60_000 } });
    await h.incoming('zulip:ops');
    t = 40 * 60_000; // past the end and past the renotify window
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(2);
    t = 45 * 60_000; // past the end, inside the window
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(2);
  });

  test('a jam with no announced end posts once per channel, however long it lasts', async () => {
    let t = 0;
    const h = harness({ now: () => t });
    await h.module.start(h.ctx);
    h.module.setFramework(h.framework as never);
    h.emit({ type: 'ops:alert', kind: 'auth-rejected', agentName: 'clerk', message: 'rejected' });
    await h.incoming('zulip:ops');
    t = 3 * 60 * 60_000;
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(1);
  });

  test('a superseding jam kind keeps the notified channels, so they still get the "back" line', async () => {
    const h = harness();
    await h.module.start(h.ctx);
    h.module.setFramework(h.framework as never);
    h.emit({ type: 'ops:alert', kind: 'quota-spent', agentName: 'clerk', message: 'spent' });
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(1);
    h.emit({ type: 'ops:alert', kind: 'quota-spent-clear', agentName: 'clerk', message: 'superseded by auth-rejected' });
    h.emit({ type: 'ops:alert', kind: 'auth-rejected', agentName: 'clerk', message: 'rejected' });
    expect(h.module.jamState()).toMatchObject({ kind: 'auth-rejected', notified: [] });
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(2); // the channel is told once about the new reason
    h.emit({ type: 'ops:alert', kind: 'auth-rejected-clear', agentName: 'clerk', message: 'anthropic credential ok' });
    expect(h.posts.length).toBe(3);
    expect(h.posts[2]!.text).toBe(jamClearText('clerk'));
  });

  test('alerts for other agents and the disabled config post nothing', async () => {
    const off = harness({ jamNotices: false });
    await off.module.start(off.ctx);
    off.module.setFramework(off.framework as never);
    off.emit({ type: 'ops:alert', kind: 'hard-down', agentName: 'clerk', message: 'x' });
    await off.incoming('zulip:ops');
    expect(off.posts).toEqual([]);

    const other = harness();
    await other.module.start(other.ctx);
    other.module.setFramework(other.framework as never);
    other.emit({ type: 'ops:alert', kind: 'hard-down', agentName: 'spawn-7', message: 'x' });
    await other.incoming('zulip:ops');
    expect(other.posts).toEqual([]);
  });
});
