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
  const broken = new Set(opts.brokenServers ?? []);
  const holds = new Map<string, Promise<void>>();
  let listener: ((e: TraceEvent) => void) | null = null;
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const framework = {
    onTrace: (cb: (e: TraceEvent) => void) => { listener = cb; return () => {}; },
    channels: {
      publishForAgent: async (channelId: string, text: string, agentName: string) => {
        const hold = holds.get(channelId);
        if (hold) { holds.delete(channelId); await hold; }
        const server = channelId.slice(0, channelId.indexOf(':'));
        if (broken.has(server)) return { success: false, error: `Server not found: ${server}` };
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
      setTimeout: (fn, ms) => { const h = { fn, ms, cancelled: false }; timers.push(h); return h; },
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
  const fireTimers = async () => { for (const h of timers.splice(0)) if (!h.cancelled) h.fn(); await settle(); };
  const setTime = (ms: number) => { t = ms; };
  /** Make the next post to a channel wait until the returned release runs. */
  const hold = (channelId: string) => { let release!: () => void; holds.set(channelId, new Promise<void>((r) => { release = r; })); return release; };
  return { module, framework, ctx, emit, incoming, alert, settle, fireTimers, setTime, hold, posts, markers, timers, broken };
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
    expect(h.posts.filter((p) => p.text.startsWith('✓'))).toEqual([]); // no false "back"
    expect(h.posts.length).toBe(5); // status channel hears the still-current reason
    expect(h.posts[4]!.text).toContain('quota-spent: spent');
    h.alert('quota-spent-clear', 'ok');
    await h.settle();
    expect(h.module.episodeState()).toEqual([]);
    expect(h.posts.filter((p) => p.text.startsWith('✓')).map((p) => p.channelId).sort()).toEqual(['zulip:dev', 'zulip:ops', 'zulip:other']);
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
    expect(h.posts.slice(2).map((p) => [p.channelId, p.text])).toEqual([
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
