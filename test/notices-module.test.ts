/**
 * NoticesModule: the host speaks in the agent's channels when the agent
 * cannot — scoped by channel pattern, tiered by alert kind, one notice per
 * episode and channel, status posts after a quiet window, pending posts
 * retried on reconnect.
 */
import { describe, expect, test } from 'bun:test';
import type { ModuleContext, TraceEvent } from '@animalabs/agent-framework';
import {
  NoticesModule,
  type NoticesModuleConfig,
  replyNoticeText,
  replyClearText,
  statusNoticeText,
  statusClearText,
  globToRegExp,
} from '../src/modules/notices-module.js';

type Post = { channelId: string; text: string; agentName: string };

function harness(cfg: Partial<NoticesModuleConfig> = {}, opts: { brokenServers?: string[] } = {}) {
  const posts: Post[] = [];
  const markers: string[] = [];
  const calls = { n: 0 };
  const broken = new Set(opts.brokenServers ?? []);
  const holds = new Map<string, Promise<void>>();
  let listener: ((e: TraceEvent) => void) | null = null;
  const timers: Array<{ fn: () => void; ms: number; due: number; cancelled: boolean }> = [];
  const framework = {
    onTrace: (cb: (e: TraceEvent) => void) => { listener = cb; return () => {}; },
    channels: {
      publishForAgent: async (channelId: string, text: string, agentName: string) => {
        calls.n++;
        // Absence is decided at call time, like a real dial; a held post then
        // fails or succeeds according to the state when it was sent.
        const server = channelId.slice(0, channelId.indexOf(':'));
        const absent = broken.has(server);
        const hold = holds.get(channelId);
        if (hold) { holds.delete(channelId); await hold; }
        if (absent) return { success: false, error: `Server not found: ${server}` };
        if (channelId.includes('grantless')) return { success: false, error: 'channels.publish not in grant' };
        posts.push({ channelId, text, agentName });
        return { success: true };
      },
    },
    getAgent: () => ({ getContextManager: () => ({ addMessage: (_p: string, content: Array<{ text: string }>) => { markers.push(content[0]!.text); return 'id'; } }) }),
  };
  let t = 0;
  const module = new NoticesModule({
    agentName: 'clerk',
    quietMs: 0,
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { const h = { fn, ms, due: t + ms, cancelled: false }; timers.push(h); return h; },
      clearTimeout: (h) => { (h as { cancelled: boolean }).cancelled = true; },
    },
    ...cfg,
  });
  const ctx = { getState: () => null, setState: () => {}, getModule: () => undefined } as unknown as ModuleContext;
  const emit = (e: Record<string, unknown>) => listener!(e as unknown as TraceEvent);
  const incoming = (channelId: string) => module.onProcess({ type: 'mcpl:channel-incoming', channelId } as never, {} as never);
  const alert = (kind: string, message = kind, data?: Record<string, unknown>, agentName = 'clerk') =>
    emit({ type: 'ops:alert', kind, agentName, message, data });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** Fire every armed timer, advancing the fake clock to each one's due time. */
  const fireTimers = async () => { for (const h of timers.splice(0)) if (!h.cancelled) { t = Math.max(t, h.due); h.fn(); } await settle(); };
  const setTime = (ms: number) => { t = ms; };
  /** Make the next post to a channel wait until the returned release runs. */
  const hold = (channelId: string) => { let release!: () => void; holds.set(channelId, new Promise<void>((r) => { release = r; })); return release; };
  return { module, framework, ctx, emit, incoming, alert, settle, fireTimers, setTime, hold, posts, markers, timers, broken, calls };
}

async function started(cfg: Partial<NoticesModuleConfig> = {}, opts: { brokenServers?: string[] } = {}) {
  const h = harness(cfg, opts);
  await h.module.start(h.ctx);
  h.module.setFramework(h.framework as never);
  return h;
}

describe('patterns and tiers', () => {
  test('globs anchor and escape', () => {
    expect(globToRegExp('zulip:*').test('zulip:ops')).toBe(true);
    expect(globToRegExp('zulip:*').test('discord:g:zulip:ops')).toBe(false);
    expect(globToRegExp('discord:g.1:*').test('discord:gx1:c')).toBe(false);
    expect(globToRegExp('*').test('anything:at:all')).toBe(true);
  });

  test('tier resolution: exact override > glob override > default > silent', () => {
    const m = new NoticesModule({ kinds: { 'auth-*': 'status', 'auth-rejected': 'reply', 'hard-down': 'silent' } });
    expect(m.tierFor('auth-expired')).toBe('status');
    expect(m.tierFor('auth-rejected')).toBe('reply');
    expect(m.tierFor('hard-down')).toBe('silent');
    expect(m.tierFor('quota-spent')).toBe('reply');
    expect(m.tierFor('never-heard-of')).toBe('silent');
  });

  test('reply scope: in minus not', () => {
    const m = new NoticesModule({ replyIn: ['zulip:*'], replyNot: ['zulip:general'] });
    expect(m.mayReplyIn('zulip:ops')).toBe(true);
    expect(m.mayReplyIn('zulip:general')).toBe(false);
    expect(m.mayReplyIn('discord:g:c')).toBe(false);
  });
});

describe('reactive replies', () => {
  test('an outage + incoming traffic posts once per channel, writes one marker, and the clear posts "back"', async () => {
    const h = await started();
    await h.incoming('zulip:ops');
    expect(h.posts).toEqual([]);
    h.alert('quota-spent', 'anthropic subscription quota spent (weekly)', { until: 7_200_000 });
    expect(h.module.episodeState()).toEqual([expect.objectContaining({ key: 'clerk', kind: 'quota-spent', tier: 'reply', until: 7_200_000, notified: [] })]);
    await h.incoming('zulip:ops');
    await h.incoming('zulip:ops');
    await h.incoming('discord:g:other');
    expect(h.posts.length).toBe(2);
    expect(h.posts[0]).toMatchObject({ channelId: 'zulip:ops', agentName: 'clerk' });
    expect(h.posts[0]!.text).toBe(replyNoticeText('clerk', { kind: 'quota-spent', message: '', until: 7_200_000 }));
    expect(h.posts[0]!.text).toContain('subscription quota is spent');
    expect(h.posts[0]!.text).toContain('Expected back after 1970-01-01 02:00 UTC');
    expect(h.posts[0]!.text).not.toContain('weekly'); // no raw message in public channels
    expect(h.markers.length).toBe(1);
    expect(h.markers[0]).toContain('[host-notice]');
    h.alert('quota-spent-clear', 'anthropic credential ok');
    await h.settle();
    expect(h.module.episodeState()).toEqual([]);
    expect(h.posts.length).toBe(4);
    expect(h.posts.slice(2).map((p) => p.text)).toEqual([replyClearText('clerk'), replyClearText('clerk')]);
    expect(h.posts.slice(2).map((p) => p.channelId).sort()).toEqual(['discord:g:other', 'zulip:ops']);
  });

  test('"reply on zulip, not on discord": the scope decides where people are told', async () => {
    const h = await started({ replyIn: ['zulip:*'], replyNot: ['zulip:general'] });
    h.alert('hard-down', '3 consecutive inference failures');
    await h.incoming('discord:g:c');
    await h.incoming('zulip:general');
    expect(h.posts).toEqual([]);
    await h.incoming('zulip:ops');
    expect(h.posts.map((p) => p.channelId)).toEqual(['zulip:ops']);
  });

  test('a status-tier kind never replies to people', async () => {
    const h = await started();
    h.alert('context-refusal', 'compile refused');
    await h.incoming('zulip:ops');
    expect(h.posts).toEqual([]);
  });

  test('a non-"not found" failure is not retried on the next message, and a superseding clear posts no "back"', async () => {
    const h = await started();
    h.alert('auth-expiring', 'expires soon');
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(0); // status tier, no status channels
    h.alert('auth-expiring-clear', 'superseded by auth-expired');
    h.alert('auth-expired', 'expired');
    await h.incoming('zulip:grantless');
    await h.incoming('zulip:grantless');
    expect(h.posts.length).toBe(0);
    expect(h.module.episodeState()[0]!.notified).toEqual([]);
    expect(h.module.episodeState()[0]!.pending).toEqual([]);
    h.alert('auth-expired-clear', 'superseded by auth-login-required');
    await h.settle();
    expect(h.module.episodeState()).toEqual([]);
    expect(h.posts.length).toBe(0);
  });

  test('re-notifies only after an ANNOUNCED end has passed and the renotify window elapsed', async () => {
    const h = await started();
    h.alert('quota-spent', 'spent', { until: 60_000 });
    await h.incoming('zulip:ops');
    h.setTime(40 * 60_000);
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(2);
    h.setTime(45 * 60_000);
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(2);
  });

  test('an outage with no announced end posts once per channel, however long it lasts', async () => {
    const h = await started();
    h.alert('auth-rejected', 'rejected');
    await h.incoming('zulip:ops');
    h.setTime(3 * 60 * 60_000);
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(1);
  });

  test('a different kind continues the episode; a superseded clear + new kind starts a fresh one', async () => {
    const h = await started();
    h.alert('quota-spent', 'spent');
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(1);
    h.alert('hard-down', 'failing'); // no clear in between: same episode
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(1);
    expect(h.module.episodeState()[0]).toMatchObject({ kind: 'hard-down', notified: ['zulip:ops'] });
    h.alert('quota-spent-clear', 'superseded by auth-rejected');
    // hard-down episode is not quota-spent: the clear does not match
    expect(h.module.episodeState().length).toBe(1);
    h.emit({ type: 'inference:completed', agentName: 'clerk' });
    await h.settle();
    expect(h.module.episodeState()).toEqual([]);
    expect(h.posts.length).toBe(2);
    expect(h.posts[1]!.text).toBe(replyClearText('clerk'));
    h.alert('auth-rejected', 'rejected');
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(3); // fresh episode: told once about the new reason
  });

  test('alerts for other agents and silent kinds post nothing', async () => {
    const h = await started();
    h.alert('hard-down', 'x', undefined, 'spawn-7');
    await h.incoming('zulip:ops');
    h.alert('refusal', 'refusal streak 2');
    await h.incoming('zulip:ops');
    expect(h.posts).toEqual([]);
    expect(h.module.episodeState()).toEqual([]);
  });

  test('recipe tiers override: hard-down silenced, auth-expiring promoted', async () => {
    const h = await started({ kinds: { 'hard-down': 'silent', 'auth-expiring': 'reply' } });
    h.alert('hard-down', 'x');
    await h.incoming('zulip:ops');
    expect(h.posts).toEqual([]);
    h.alert('auth-expiring', 'expires in 20 min');
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(1);
  });
});

describe('overlapping kinds', () => {
  test('a status-tier alert mid-outage neither downgrades the reply tier nor, on its clear, ends the episode', async () => {
    const h = await started({ statusChannels: ['zulip:ops'] });
    h.alert('quota-spent', 'spent', { until: 3_600_000 });
    await h.settle();
    await h.incoming('zulip:dev');
    expect(h.posts.map((p) => p.channelId)).toEqual(['zulip:ops', 'zulip:dev']);
    h.alert('compression-quarantine', '2 chunk(s) in compression quarantine');
    await h.settle();
    expect(h.module.episodeState()[0]).toMatchObject({ kind: 'quota-spent', kinds: ['quota-spent', 'compression-quarantine'], tier: 'reply', until: 3_600_000 });
    expect(h.posts.length).toBe(3); // status channel hears the new kind
    expect(h.posts[2]!.text).toContain('compression-quarantine');
    await h.incoming('zulip:other');
    expect(h.posts.length).toBe(4); // people are still told about the outage
    expect(h.posts[3]!.text).toContain('subscription quota is spent');
    h.alert('compression-quarantine-clear', 'EMPTY');
    await h.settle();
    expect(h.module.episodeState()[0]).toMatchObject({ kinds: ['quota-spent'], tier: 'reply' });
    // The status channel hears that the lesser kind cleared and what remains;
    // no reply channel hears a false "back".
    expect(h.posts.length).toBe(5);
    expect(h.posts[4]).toMatchObject({ channelId: 'zulip:ops', text: statusClearText('clerk', 'compression-quarantine', 'EMPTY', 'quota-spent') });
    h.alert('quota-spent-clear', 'ok');
    await h.settle();
    expect(h.module.episodeState()).toEqual([]);
    expect(h.posts.slice(5).map((p) => [p.channelId, p.text]).sort()).toEqual([
      ['zulip:dev', replyClearText('clerk')],
      ['zulip:ops', statusClearText('clerk', 'quota-spent', 'ok')],
      ['zulip:other', replyClearText('clerk')],
    ]);
  });

  test('the primary kind is the newest among the loudest', async () => {
    const h = await started();
    h.alert('context-refusal', 'compile refused');
    h.setTime(1000);
    h.alert('hard-down', 'failing');
    h.setTime(2000);
    h.alert('auth-expiring', 'soon');
    expect(h.module.episodeState()[0]).toMatchObject({ kind: 'hard-down', tier: 'reply' });
    await h.incoming('zulip:dev');
    expect(h.posts[0]!.text).toContain('model calls keep failing');
  });

  test('a kind promoted to reply by the recipe gets canned text, never the alert message', async () => {
    const h = await started({ kinds: { 'quota-unreadable': 'reply' } });
    h.alert('quota-unreadable', 'usage endpoint answered HTTP 429 (token sk-ant-…)');
    await h.incoming('zulip:dev');
    expect(h.posts.length).toBe(1);
    expect(h.posts[0]!.text).toContain('temporarily unavailable (quota-unreadable)');
    expect(h.posts[0]!.text).not.toContain('HTTP 429');
  });
});

describe('waker replies', () => {
  test('the channel whose turn failed is told when the alert lands, even with no further traffic', async () => {
    const h = await started({ replyIn: ['zulip:*'] });
    h.emit({ type: 'inference:started', agentName: 'clerk', channelId: 'zulip:dev' });
    h.emit({ type: 'inference:exhausted', agentName: 'clerk', error: 'boom' });
    await h.settle();
    expect(h.posts).toEqual([]); // one failure is not an outage
    h.alert('hard-down', '3 consecutive inference failures');
    await h.settle();
    expect(h.posts.map((p) => p.channelId)).toEqual(['zulip:dev']);
    await h.incoming('zulip:dev');
    expect(h.posts.length).toBe(1); // already told
  });

  test('a failed turn during an open outage tells its channel; out-of-scope wakers are skipped', async () => {
    const h = await started({ replyIn: ['zulip:*'] });
    h.alert('quota-spent', 'spent');
    h.emit({ type: 'inference:started', agentName: 'clerk', channelId: 'discord:g:c' });
    h.emit({ type: 'inference:exhausted', agentName: 'clerk', error: 'boom' });
    await h.settle();
    expect(h.posts).toEqual([]);
    h.emit({ type: 'inference:started', agentName: 'clerk', channelId: 'zulip:dev' });
    h.emit({ type: 'inference:exhausted', agentName: 'clerk', error: 'boom' });
    await h.settle();
    expect(h.posts.map((p) => p.channelId)).toEqual(['zulip:dev']);
  });

  test('a stale failure outside the waker window is not answered', async () => {
    const h = await started();
    h.emit({ type: 'inference:started', agentName: 'clerk', channelId: 'zulip:dev' });
    h.emit({ type: 'inference:exhausted', agentName: 'clerk', error: 'boom' });
    h.setTime(11 * 60_000);
    h.alert('hard-down', 'x');
    await h.settle();
    expect(h.posts).toEqual([]);
  });
});

describe('status channels', () => {
  test('status posts carry the operator message after the quiet window; a flap inside it says nothing', async () => {
    const h = await started({ statusChannels: ['zulip:ops'], quietMs: 60_000 });
    h.alert('context-refusal', 'compile refused (over_budget): 212k > 200k');
    expect(h.timers.length).toBe(1);
    h.emit({ type: 'inference:completed', agentName: 'clerk' });
    await h.settle();
    expect(h.timers[0]!.cancelled).toBe(true);
    expect(h.posts).toEqual([]);

    h.alert('quota-spent', 'anthropic subscription quota spent (weekly)', { until: 3_600_000 });
    await h.fireTimers();
    expect(h.posts.length).toBe(1);
    expect(h.posts[0]!.text).toBe(statusNoticeText('clerk', { kind: 'quota-spent', message: 'anthropic subscription quota spent (weekly)', until: 3_600_000 }));
    expect(h.posts[0]!.text).toContain('quota-spent: anthropic subscription quota spent (weekly)');
    h.alert('quota-spent-clear', 'anthropic credential ok');
    await h.settle();
    expect(h.posts.length).toBe(2);
    expect(h.posts[1]!.text).toBe(statusClearText('clerk', 'quota-spent', 'anthropic credential ok'));
  });

  test('a status channel that also matches the reply scope is told once, as status', async () => {
    const h = await started({ statusChannels: ['zulip:ops'] });
    h.alert('hard-down', 'failing');
    await h.settle();
    expect(h.posts.length).toBe(1);
    await h.incoming('zulip:ops');
    expect(h.posts.length).toBe(1);
    await h.incoming('zulip:dev');
    expect(h.posts.length).toBe(2);
    expect(h.posts[1]!.text).toBe(replyNoticeText('clerk', { kind: 'hard-down', message: 'failing' }));
    h.emit({ type: 'inference:completed', agentName: 'clerk' });
    await h.settle();
    expect(h.posts.slice(2).map((p) => [p.channelId, p.text]).sort()).toEqual([
      ['zulip:dev', replyClearText('clerk')],
      ['zulip:ops', statusClearText('clerk', 'hard-down', 'inference completed')],
    ]);
  });

  test('a clear that lands while the status post is in flight still produces a clear line', async () => {
    const h = await started({ statusChannels: ['zulip:ops'] });
    const release = h.hold('zulip:ops');
    h.alert('quota-spent', 'spent');
    await h.settle();
    expect(h.posts).toEqual([]);
    h.alert('quota-spent-clear', 'ok');
    await h.settle();
    expect(h.module.episodeState()).toEqual([]);
    expect(h.posts).toEqual([]); // nothing delivered yet ⇒ nothing to clear yet
    release();
    await h.settle();
    await h.settle();
    expect(h.posts.map((p) => p.text.slice(0, 1))).toEqual(['⚠', '✓']);
    expect(h.posts[1]!.text).toBe(statusClearText('clerk', 'quota-spent', 'cleared while posting'));
  });

  test('a kind change within an episode re-posts to status channels after the quiet window', async () => {
    const h = await started({ statusChannels: ['zulip:ops'], quietMs: 1000 });
    h.alert('quota-spent', 'spent');
    await h.fireTimers();
    expect(h.posts.length).toBe(1);
    h.alert('auth-rejected', 'rejected');
    expect(h.posts.length).toBe(1);
    await h.fireTimers();
    expect(h.posts.length).toBe(2);
    expect(h.posts[1]!.text).toContain('auth-rejected: rejected');
  });

  test('a kind joining mid-episode does not delay a kind already due; each kind has its own quiet deadline', async () => {
    const h = await started({ statusChannels: ['zulip:ops'], quietMs: 60_000 });
    h.alert('quota-spent', 'spent');
    h.setTime(59_000);
    h.alert('compression-quarantine', '2 chunks');
    expect(h.timers.filter((x) => !x.cancelled).length).toBe(1);
    await h.fireTimers(); // clock → 60 000
    expect(h.posts.map((p) => p.text)).toEqual([statusNoticeText('clerk', { kind: 'quota-spent', message: 'spent' })]);
    await h.fireTimers(); // clock → 119 000
    expect(h.posts.length).toBe(2);
    expect(h.posts[1]!.text).toContain('compression-quarantine: 2 chunks');
  });

  test('a kind that clears while its status post is in flight is cleared right after it lands', async () => {
    const h = await started({ statusChannels: ['zulip:ops'] });
    const release = h.hold('zulip:ops');
    h.alert('compression-quarantine', '2 chunks'); // held
    h.alert('quota-spent', 'spent'); // delivered
    await h.settle();
    expect(h.posts.map((p) => p.text)).toEqual([statusNoticeText('clerk', { kind: 'quota-spent', message: 'spent' })]);
    h.alert('compression-quarantine-clear', 'EMPTY');
    await h.settle();
    expect(h.posts.length).toBe(1); // nothing heard yet ⇒ nothing to clear yet
    release();
    await h.settle();
    await h.settle();
    expect(h.posts.slice(1).map((p) => p.text)).toEqual([
      statusNoticeText('clerk', { kind: 'compression-quarantine', message: '2 chunks' }),
      statusClearText('clerk', 'compression-quarantine', 'cleared while posting', 'quota-spent'),
    ]);
    expect(h.module.episodeState()[0]).toMatchObject({ kinds: ['quota-spent'], statusHeard: { 'zulip:ops': ['quota-spent'] } });
  });

  test('a component post landing after reconnect clears itself and writes no agent marker', async () => {
    const h = await started({ statusChannels: ['zulip:ops'] });
    const release = h.hold('zulip:ops');
    h.alert('mcpl-down', 'unreachable', undefined, 'discord');
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'discord', attempts: 1 });
    await h.settle();
    expect(h.module.episodeState()).toEqual([]);
    release();
    await h.settle();
    await h.settle();
    expect(h.posts.map((p) => p.text.slice(0, 1))).toEqual(['⚠', '✓']);
    expect(h.posts[1]!.text).toBe(statusClearText('discord', 'mcpl-down', 'cleared while posting'));
    expect(h.markers).toEqual([]);
  });

  test('an overdue parked kind does not stop a newer kind from getting its deadline', async () => {
    const h = await started({ statusChannels: ['zulip:ops'], quietMs: 60_000 }, { brokenServers: ['zulip'] });
    h.alert('quota-spent', 'spent');
    await h.fireTimers(); // clock → 60 000; the post fails, the channel is parked
    expect(h.posts).toEqual([]);
    expect(h.module.episodeState()[0]!.pending).toEqual(['zulip:ops']);
    h.setTime(70_000);
    h.alert('auth-rejected', 'rejected'); // due at 130 000
    expect(h.timers.filter((x) => !x.cancelled).map((x) => x.due)).toEqual([130_000]);
    h.broken.clear();
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 });
    await h.settle();
    await h.settle();
    expect(h.posts.map((p) => p.text)).toEqual([statusNoticeText('clerk', { kind: 'quota-spent', message: 'spent' })]);
    expect(h.module.episodeState()[0]!.pending).toEqual([]);
    await h.fireTimers(); // clock → 130 000
    expect(h.posts.length).toBe(2);
    expect(h.posts[1]!.text).toContain('auth-rejected: rejected');
  });

  test('a superseded kind forgets its delivery record, so its return is told again', async () => {
    const h = await started({ statusChannels: ['zulip:ops'] });
    h.alert('compression-quarantine', '2 chunks');
    h.alert('auth-rejected', 'rejected');
    await h.settle();
    expect(h.posts.length).toBe(2);
    h.alert('auth-rejected-clear', 'superseded by auth-login-required');
    h.alert('auth-login-required', 'login');
    await h.settle();
    expect(h.posts.length).toBe(3);
    h.alert('auth-login-required-clear', 'ok');
    await h.settle();
    expect(h.posts.length).toBe(4);
    expect(h.posts[3]!.text).toBe(statusClearText('clerk', 'auth-login-required', 'ok', 'compression-quarantine'));
    h.alert('auth-rejected', 'rejected again');
    await h.settle();
    expect(h.posts.length).toBe(5);
    expect(h.posts[4]!.text).toContain('auth-rejected: rejected again');
  });

  test('a kind cleared and re-raised while its post is in flight is told anew with the new message', async () => {
    const h = await started({ statusChannels: ['zulip:ops'] });
    h.alert('quota-spent', 'spent');
    await h.settle();
    const release = h.hold('zulip:ops');
    h.alert('compression-quarantine', '2 chunks'); // held
    h.alert('compression-quarantine-clear', 'EMPTY');
    h.alert('compression-quarantine', '3 chunks');
    await h.settle();
    // The new occurrence is not blocked by the old one's in-flight claim.
    expect(h.posts.map((p) => p.text)).toEqual([
      statusNoticeText('clerk', { kind: 'quota-spent', message: 'spent' }),
      statusNoticeText('clerk', { kind: 'compression-quarantine', message: '3 chunks' }),
    ]);
    release();
    await h.settle();
    await h.settle();
    const texts = h.posts.map((p) => p.text);
    expect(texts.length).toBe(3); // the old post lands late, says nothing more
    expect(texts.filter((t) => t.includes('3 chunks')).length).toBe(1);
    expect(texts.filter((t) => t.startsWith('✓'))).toEqual([]);
    expect(h.module.episodeState()[0]!.statusHeard).toEqual({ 'zulip:ops': ['quota-spent', 'compression-quarantine'] });
  });

  test('component alerts (mcpl-down) are status-only, keyed by server, and close on reconnect', async () => {
    const h = await started({ statusChannels: ['zulip:ops'], kinds: { 'mcpl-down': 'reply' } });
    h.alert('mcpl-down', 'MCPL server unreachable (attempt 5)', undefined, 'discord');
    await h.settle();
    expect(h.module.episodeState()).toEqual([expect.objectContaining({ key: 'discord', kind: 'mcpl-down', tier: 'status' })]);
    expect(h.posts.length).toBe(1);
    expect(h.posts[0]!.text).toContain('discord — mcpl-down');
    await h.incoming('zulip:dev');
    expect(h.posts.length).toBe(1); // never replies to people
    expect(h.markers).toEqual([]); // no agent marker for component episodes
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'discord', attempts: 3 });
    await h.settle();
    expect(h.module.episodeState()).toEqual([]);
    expect(h.posts[1]!.text).toBe(statusClearText('discord', 'mcpl-down', 'reconnected'));
  });
});

describe('absent chat server', () => {
  test('a post to an absent server is parked and delivered on reconnect while the episode is open', async () => {
    const h = await started({ statusChannels: ['zulip:ops'] }, { brokenServers: ['zulip'] });
    h.alert('quota-spent', 'spent');
    await h.settle();
    await h.incoming('zulip:dev');
    expect(h.posts).toEqual([]);
    expect(h.module.episodeState()[0]!.pending.sort()).toEqual(['zulip:dev', 'zulip:ops']);
    h.broken.clear();
    h.emit({ type: 'module:added', moduleName: 'zulip' });
    await h.settle();
    expect(h.posts.map((p) => p.channelId).sort()).toEqual(['zulip:dev', 'zulip:ops']);
    expect(h.module.episodeState()[0]!.pending).toEqual([]);
    expect(h.markers.length).toBe(1);
  });

  test('parked posts are dropped when the episode closes first', async () => {
    const h = await started({ statusChannels: ['zulip:ops'] }, { brokenServers: ['zulip'] });
    h.alert('quota-spent', 'spent');
    await h.settle();
    h.alert('quota-spent-clear', 'ok');
    await h.settle();
    h.broken.clear();
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 });
    await h.settle();
    expect(h.posts).toEqual([]);
  });

  test('a status update parked behind an already-heard kind is still delivered on reconnect', async () => {
    const h = await started({ statusChannels: ['zulip:ops'] });
    h.alert('compression-quarantine', '2 chunks');
    await h.settle();
    expect(h.posts.length).toBe(1);
    h.broken.add('zulip');
    h.alert('auth-rejected', 'rejected');
    await h.settle();
    expect(h.posts.length).toBe(1);
    expect(h.module.episodeState()[0]!.pending).toEqual(['zulip:ops']);
    h.broken.clear();
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 2 });
    await h.settle();
    await h.settle();
    expect(h.posts.length).toBe(2);
    expect(h.posts[1]!.text).toContain('auth-rejected: rejected');
    expect(h.module.episodeState()[0]!.statusHeard).toEqual({ 'zulip:ops': ['compression-quarantine', 'auth-rejected'] });
  });

  test('a parked reply delivered another way is not sent twice on reconnect', async () => {
    const h = await started({}, { brokenServers: ['zulip'] });
    h.alert('quota-spent', 'spent');
    await h.incoming('zulip:dev');
    expect(h.module.episodeState()[0]!.pending).toEqual(['zulip:dev']);
    h.broken.clear();
    await h.incoming('zulip:dev'); // the server came back; the next message is answered
    expect(h.posts.length).toBe(1);
    expect(h.module.episodeState()[0]!.pending).toEqual([]);
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 });
    await h.settle();
    expect(h.posts.length).toBe(1);
  });

  test('a parked reply is not replayed once the episode has dropped to status tier', async () => {
    const h = await started({}, { brokenServers: ['zulip'] });
    h.alert('quota-spent', 'spent');
    h.alert('context-refusal', 'over budget');
    await h.incoming('zulip:dev');
    expect(h.module.episodeState()[0]!.pending).toEqual(['zulip:dev']);
    h.alert('quota-spent-clear', 'ok');
    await h.settle();
    expect(h.module.episodeState()[0]).toMatchObject({ kinds: ['context-refusal'], tier: 'status' });
    h.broken.clear();
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 });
    await h.settle();
    expect(h.posts).toEqual([]);
  });

  test('a reply parked mid-reconnect is re-admitted, not resent: a cleared outage posts nothing', async () => {
    const h = await started({}, { brokenServers: ['zulip'] });
    h.alert('quota-spent', 'spent');
    h.alert('context-refusal', 'over budget');
    const release = h.hold('zulip:dev');
    void h.incoming('zulip:dev'); // reply attempt in flight, will fail (server absent at call time)
    h.broken.clear();
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 }); // flush deduplicated against the in-flight attempt
    h.alert('quota-spent-clear', 'ok'); // tier drops to status while the attempt is in flight
    release();
    await h.settle();
    await h.settle();
    expect(h.posts).toEqual([]);
    expect(h.module.episodeState()[0]).toMatchObject({ kinds: ['context-refusal'], tier: 'status', notified: [], pending: [] });
  });

  test('a reply parked mid-reconnect is re-admitted and delivered while the outage is on', async () => {
    const h = await started({}, { brokenServers: ['zulip'] });
    h.alert('quota-spent', 'spent');
    const release = h.hold('zulip:dev');
    void h.incoming('zulip:dev');
    h.broken.clear();
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 });
    release();
    await h.settle();
    await h.settle();
    expect(h.posts.map((p) => p.channelId)).toEqual(['zulip:dev']);
    expect(h.module.episodeState()[0]!.pending).toEqual([]);
  });

  test('two posts failing after a reconnect do not chain into an endless retry loop', async () => {
    const h = await started({ statusChannels: ['zulip:a', 'zulip:b'] }, { brokenServers: ['zulip'] });
    const releaseA = h.hold('zulip:a');
    const releaseB = h.hold('zulip:b');
    h.alert('quota-spent', 'spent'); // both posts in flight, both will fail
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 }); // still absent in truth
    releaseA();
    releaseB();
    for (let i = 0; i < 6; i++) await h.settle();
    const after = h.calls.n;
    for (let i = 0; i < 6; i++) await h.settle();
    expect(h.calls.n).toBe(after); // quiescent
    expect(after).toBeLessThanOrEqual(6); // 2 attempts + at most 2 re-flushes × 2 channels
    expect(h.module.episodeState()[0]!.pending.sort()).toEqual(['zulip:a', 'zulip:b']);
    expect(h.posts).toEqual([]);
  });

  test('a reflush request belongs to the post that failed, not to whichever caller finishes first', async () => {
    const h = await started({ statusChannels: ['slack:ops', 'zulip:ops'] }, { brokenServers: ['zulip'] });
    const releaseSlack = h.hold('slack:ops');
    const releaseZulip = h.hold('zulip:ops');
    h.alert('quota-spent', 'spent');
    h.broken.clear();
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 }); // deduplicated against both claims
    releaseSlack(); // succeeds; must not consume zulip's retry
    await h.settle();
    releaseZulip(); // fails against the old state, asks for its own re-flush
    for (let i = 0; i < 4; i++) await h.settle();
    expect(h.posts.map((p) => p.channelId).sort()).toEqual(['slack:ops', 'zulip:ops']);
    expect(h.module.episodeState()[0]!.statusHeard).toEqual({ 'slack:ops': ['quota-spent'], 'zulip:ops': ['quota-spent'] });
    expect(h.module.episodeState()[0]!.pending).toEqual([]);
  });

  test('clear and "back" lines that fail on an absent server are owed and delivered on reconnect', async () => {
    const h = await started({ statusChannels: ['zulip:ops'] });
    h.alert('quota-spent', 'spent');
    h.alert('compression-quarantine', '2 chunks');
    await h.settle();
    await h.incoming('zulip:dev');
    expect(h.posts.length).toBe(3);
    h.broken.add('zulip');
    h.alert('compression-quarantine-clear', 'EMPTY');
    h.alert('quota-spent-clear', 'ok'); // episode closes while the server is down
    await h.settle();
    expect(h.posts.length).toBe(3);
    expect(h.module.episodeState()).toEqual([]);
    expect(h.module.owedState()).toEqual({
      'zulip:ops': [statusClearText('clerk', 'compression-quarantine', 'EMPTY', 'quota-spent'), statusClearText('clerk', 'quota-spent', 'ok')],
      'zulip:dev': [replyClearText('clerk')],
    });
    h.broken.delete('zulip');
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 });
    for (let i = 0; i < 4; i++) await h.settle();
    expect(h.posts.slice(3).map((p) => [p.channelId, p.text])).toEqual([
      ['zulip:ops', statusClearText('clerk', 'compression-quarantine', 'EMPTY', 'quota-spent')],
      ['zulip:ops', statusClearText('clerk', 'quota-spent', 'ok')],
      ['zulip:dev', replyClearText('clerk')],
    ]);
    expect(h.module.owedState()).toEqual({});
  });

  test('owed lines keep their order across a reconnect that does not bring the server back', async () => {
    const h = await started({ statusChannels: ['zulip:ops'] });
    h.alert('quota-spent', 'spent');
    h.alert('compression-quarantine', '2 chunks');
    await h.settle();
    h.broken.add('zulip');
    h.alert('compression-quarantine-clear', 'EMPTY');
    h.alert('quota-spent-clear', 'ok');
    await h.settle();
    const expected = [statusClearText('clerk', 'compression-quarantine', 'EMPTY', 'quota-spent'), statusClearText('clerk', 'quota-spent', 'ok')];
    expect(h.module.owedState()).toEqual({ 'zulip:ops': expected });
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'discord', attempts: 1 }); // unrelated server
    for (let i = 0; i < 3; i++) await h.settle();
    expect(h.module.owedState()).toEqual({ 'zulip:ops': expected }); // same order
    h.broken.delete('zulip');
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 });
    for (let i = 0; i < 3; i++) await h.settle();
    expect(h.posts.slice(2).map((p) => p.text)).toEqual(expected);
  });

  test('flushes run one at a time: a line owed while a flush waits is neither lost nor doubled', async () => {
    const h = await started({ statusChannels: ['slack:ops', 'zulip:ops'] });
    h.alert('quota-spent', 'spent');
    h.alert('compression-quarantine', '2 chunks');
    await h.settle();
    h.broken.add('slack'); h.broken.add('zulip');
    h.alert('compression-quarantine-clear', 'EMPTY');
    await h.settle();
    expect(Object.keys(h.module.owedState()).sort()).toEqual(['slack:ops', 'zulip:ops']);
    h.broken.clear();
    const releaseSlack = h.hold('slack:ops');
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'slack', attempts: 1 }); // flush #1 waits on slack
    await h.settle();
    h.alert('quota-spent-clear', 'ok'); // delivered directly (servers are back), nothing new owed
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 }); // flush #2 queues behind #1
    await h.settle();
    releaseSlack();
    for (let i = 0; i < 6; i++) await h.settle();
    const texts = h.posts.slice(4).map((p) => [p.channelId, p.text]);
    const quarantineClear = statusClearText('clerk', 'compression-quarantine', 'EMPTY', 'quota-spent');
    expect(texts.filter(([ch, t]) => ch === 'zulip:ops' && t === quarantineClear).length).toBe(1);
    expect(texts.filter(([ch, t]) => ch === 'slack:ops' && t === quarantineClear).length).toBe(1);
    expect(h.module.owedState()).toEqual({});
  });

  test('an owed "back" line overtaken by a new outage is absorbed: no false recovery, and the new episode clears the channel', async () => {
    const h = await started();
    h.alert('quota-spent', 'spent');
    await h.incoming('zulip:dev');
    expect(h.posts.length).toBe(1);
    h.broken.add('zulip');
    h.alert('quota-spent-clear', 'ok');
    await h.settle();
    expect(h.module.owedState()).toEqual({ 'zulip:dev': [replyClearText('clerk')] });
    h.alert('auth-rejected', 'rejected'); // down again before the server returns; zulip:dev never hears of it
    h.broken.delete('zulip');
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 });
    for (let i = 0; i < 3; i++) await h.settle();
    expect(h.posts.length).toBe(1); // no false "can respond again"
    expect(h.module.owedState()).toEqual({});
    expect(h.module.episodeState()[0]!.notified).toEqual(['zulip:dev']); // debt carried: still warned
    await h.incoming('zulip:dev');
    expect(h.posts.length).toBe(1); // not warned twice
    h.alert('auth-rejected-clear', 'ok');
    await h.settle();
    expect(h.posts[1]!.text).toBe(replyClearText('clerk')); // the live episode clears the channel
  });

  test('an owed status clear overtaken by the kind returning is absorbed, and cleared even inside the quiet window', async () => {
    const h = await started({ statusChannels: ['zulip:ops'], quietMs: 60_000 });
    h.alert('compression-quarantine', '2 chunks');
    await h.fireTimers();
    expect(h.posts.length).toBe(1);
    h.broken.add('zulip');
    h.alert('compression-quarantine-clear', 'EMPTY');
    await h.settle();
    expect(h.module.owedState()).toEqual({ 'zulip:ops': [statusClearText('clerk', 'compression-quarantine', 'EMPTY')] });
    h.alert('compression-quarantine', '5 chunks'); // returns, within its quiet window
    h.broken.delete('zulip');
    h.emit({ type: 'mcpl:server-reconnected', serverId: 'zulip', attempts: 1 });
    for (let i = 0; i < 3; i++) await h.settle();
    expect(h.posts.length).toBe(1); // stale clear not sent, new occurrence not yet due
    expect(h.module.episodeState()[0]!.statusHeard).toEqual({ 'zulip:ops': ['compression-quarantine'] });
    h.alert('compression-quarantine-clear', 'EMPTY again'); // clears inside quietMs
    await h.settle();
    expect(h.posts.length).toBe(2);
    expect(h.posts[1]!.text).toBe(statusClearText('clerk', 'compression-quarantine', 'EMPTY again'));
  });

  test('literal channel ids naming servers outside the recipe warn once at start', async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const h = harness({ statusChannels: ['zulip:ops', 'slack:ops'], replyIn: ['discord:*', 'matrix:room'], knownServers: ['zulip', 'discord'] });
      await h.module.start(h.ctx);
      h.module.setKnownServers(['zulip', 'discord']);
    } finally {
      console.warn = orig;
    }
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('slack, matrix');
    expect(warnings[0]).not.toContain('discord');
  });
});
