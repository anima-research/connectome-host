import { describe, expect, test } from 'bun:test';
import {
  QuotaMeter,
  formatQuotaReadout,
  parseAnthropicUsage,
  parseCodexRateLimits,
  quotaProviderHold,
  type QuotaSource,
  type QuotaWindow,
} from '../src/quota-meter.js';

const HOUR = 3_600_000;

function fakeSource(answers: Array<QuotaWindow[] | Error>): QuotaSource & { calls: number } {
  const source = {
    provider: 'fake',
    calls: 0,
    async fetchWindows(): Promise<QuotaWindow[]> {
      const answer = answers[Math.min(source.calls, answers.length - 1)]!;
      source.calls++;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return source;
}

function rateLimit(): Error {
  return Object.assign(new Error("This request would exceed your account's rate limit."), { type: 'rate_limit' });
}

describe('parseAnthropicUsage', () => {
  test('reads every window the plan reports, longest first', () => {
    const windows = parseAnthropicUsage({
      five_hour: { utilization: 99.4, resets_at: '2026-09-21T15:00:00+00:00' },
      seven_day: { utilization: 10, resets_at: '2026-09-25T00:00:00+00:00' },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 3, resets_at: null },
      extra_usage: { is_enabled: false },
    });
    expect(windows.map((w) => [w.key, w.label, w.utilization])).toEqual([
      ['seven_day', 'weekly', 10],
      ['seven_day_sonnet', 'sonnet wk', 3],
      ['five_hour', '5h', 99.4],
    ]);
    expect(windows[0]!.resetsAt).toBe(Date.parse('2026-09-25T00:00:00Z'));
    expect(windows[1]!.resetsAt).toBeUndefined();
    expect(windows[1]!.model).toBe('sonnet');
  });

  test('model-scoped limits[] become weekly windows without duplicating named ones', () => {
    const windows = parseAnthropicUsage({
      seven_day: { utilization: 40, resets_at: '2026-09-25T00:00:00Z' },
      seven_day_opus: { utilization: 70, resets_at: '2026-09-25T00:00:00Z' },
      limits: [
        { kind: 'weekly_scoped', percent: 55, resets_at: '2026-09-25T00:00:00Z', scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', percent: 70, resets_at: '2026-09-25T00:00:00Z', scope: { model: { display_name: 'Opus' } } },
        { kind: 'mystery' },
      ],
    });
    expect(windows.map((w) => w.label)).toEqual(['weekly', 'fable wk', 'opus wk']);
  });

  test('the live response shape (max plan, 2026-09-21), trimmed', () => {
    // Unknown window keys come and go server-side; they must be ignored, and
    // limits[] repeats the session/weekly windows under other kinds.
    const windows = parseAnthropicUsage({
      five_hour: { utilization: 20, resets_at: '2026-09-21T12:00:00.205547+00:00', limit_dollars: null, locked_reason: null },
      seven_day: { utilization: 13, resets_at: '2026-09-26T06:00:00.205570+00:00', limit_dollars: null, locked_reason: null },
      seven_day_oauth_apps: null,
      seven_day_opus: null,
      seven_day_sonnet: null,
      nimbus_quill: { utilization: 0, resets_at: null },
      extra_usage: { is_enabled: false, utilization: null },
      limits: [
        { kind: 'session', group: 'session', percent: 20, resets_at: '2026-09-21T12:00:00.205547+00:00', scope: null, is_active: false },
        { kind: 'weekly_all', group: 'weekly', percent: 13, resets_at: '2026-09-26T06:00:00.128872+00:00', scope: null, is_active: false },
        {
          kind: 'weekly_scoped', group: 'weekly', percent: 25, resets_at: '2026-09-26T06:00:00.129053+00:00',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true,
        },
      ],
      spend: { percent: 0, enabled: false },
    });
    expect(windows.map((w) => `${w.utilization}% ${w.label}`).join(' | ')).toBe('13% weekly | 25% fable wk | 20% 5h');
    expect(windows[1]!.model).toBe('fable');
    expect(windows[1]!.resetsAt).toBe(Date.parse('2026-09-26T06:00:00.129053Z'));
  });

  test('an unrecognisable body is no reading, not a guess', () => {
    expect(parseAnthropicUsage(null)).toEqual([]);
    expect(parseAnthropicUsage('<html>')).toEqual([]);
    expect(parseAnthropicUsage({ five_hour: { utilization: 'lots' } })).toEqual([]);
  });
});

describe('parseCodexRateLimits', () => {
  test('labels windows by duration; resetsAt is epoch seconds', () => {
    const windows = parseCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: 1790000000 },
        secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1790587734 },
      },
    });
    expect(windows).toEqual([
      { key: '10080m', label: 'weekly', utilization: 10, resetsAt: 1790587734000 },
      { key: '300m', label: '5h', utilization: 62, resetsAt: 1790000000000 },
    ]);
  });

  test('a single weekly window with a null secondary (prolite)', () => {
    const windows = parseCodexRateLimits({
      rateLimits: { primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1790587734 }, secondary: null },
    });
    expect(windows.map((w) => w.label)).toEqual(['weekly']);
    expect(parseCodexRateLimits(null)).toEqual([]);
  });
});

describe('formatQuotaReadout', () => {
  test('prints every window', () => {
    expect(formatQuotaReadout({
      provider: 'anthropic',
      fetchedAt: 1,
      windows: [
        { key: 'seven_day', label: 'weekly', utilization: 10.9 },
        { key: 'five_hour', label: '5h', utilization: 99 },
      ],
    })).toBe('10% weekly | 99% 5h');
  });

  test('no reading prints nothing; a failed refresh marks the last one stale', () => {
    expect(formatQuotaReadout(null)).toBeNull();
    expect(formatQuotaReadout({ provider: 'x', fetchedAt: 0, windows: [], error: 'HTTP 404' })).toBeNull();
    expect(formatQuotaReadout({
      provider: 'x', fetchedAt: 1, error: 'HTTP 429',
      windows: [{ key: 'five_hour', label: '5h', utilization: 50 }],
    })).toBe('50% 5h (stale)');
  });
});

describe('QuotaMeter', () => {
  test('refreshes are single-flight and floored', async () => {
    let now = 1_000_000;
    const source = fakeSource([[{ key: 'five_hour', label: '5h', utilization: 5 }]]);
    const meter = new QuotaMeter(source, { now: () => now });
    await Promise.all([meter.refresh(), meter.refresh(), meter.refresh()]);
    expect(source.calls).toBe(1);
    now += 10_000;
    await meter.refresh();
    expect(source.calls).toBe(1);
    now += 30_000;
    await meter.refresh();
    expect(source.calls).toBe(2);
    meter.dispose();
  });

  test('a failed read keeps the previous windows and backs off', async () => {
    let now = 1_000_000;
    const source = fakeSource([[{ key: 'five_hour', label: '5h', utilization: 5 }], new Error('HTTP 429')]);
    const meter = new QuotaMeter(source, { now: () => now });
    await meter.refresh();
    now += 31_000;
    const snapshot = await meter.refresh();
    expect(snapshot?.error).toBe('HTTP 429');
    expect(snapshot?.windows).toHaveLength(1);
    now += 31_000; // inside the doubled floor
    await meter.refresh();
    expect(source.calls).toBe(2);
    now += 31_000;
    await meter.refresh();
    expect(source.calls).toBe(3);
    meter.dispose();
  });

  test('blockedUntil: spent windows only, latest reset, never one already past', async () => {
    const now = 1_000_000;
    const meter = new QuotaMeter(fakeSource([[
      { key: 'seven_day', label: 'weekly', utilization: 100, resetsAt: now + 50 * HOUR },
      { key: 'five_hour', label: '5h', utilization: 100, resetsAt: now + 2 * HOUR },
      { key: 'stale', label: 'stale', utilization: 100, resetsAt: now - 1 },
      { key: 'apps', label: 'apps wk', utilization: 100, resetsAt: now + 99 * HOUR, advisory: true },
    ]]), { now: () => now });
    expect(meter.blockedUntil()).toBeUndefined();
    await meter.refresh();
    expect(meter.blockedUntil()).toBe(now + 50 * HOUR);
    meter.dispose();
  });

  test('a spent model window blocks only that model', async () => {
    const now = 1_000_000;
    const meter = new QuotaMeter(fakeSource([[
      { key: 'seven_day', label: 'weekly', utilization: 60, resetsAt: now + 50 * HOUR },
      { key: 'seven_day_opus', label: 'opus wk', utilization: 100, resetsAt: now + 50 * HOUR, model: 'opus' },
    ]]), { now: () => now });
    await meter.refresh();
    expect(meter.blockedUntil('claude-sonnet-5')).toBeUndefined();
    expect(meter.blockedUntil()).toBeUndefined();
    expect(meter.blockedUntil('claude-opus-5')).toBe(now + 50 * HOUR);
    meter.dispose();
  });
});

describe('quotaProviderHold', () => {
  test('a 429 on a spent window parks in slices; anything else retries as before', async () => {
    const now = 1_000_000;
    const meter = new QuotaMeter(fakeSource([[
      { key: 'seven_day', label: 'weekly', utilization: 100, resetsAt: now + 50 * HOUR },
    ]]), { now: () => now });
    const hold = quotaProviderHold(meter, () => 'claude-opus-5', () => now);

    // Nothing known yet: ordinary retry — but the consultation kicks a read.
    expect(hold(rateLimit(), 'agent')).toBeUndefined();
    await meter.refresh();

    expect(hold(new Error('overloaded'), 'agent')).toBeUndefined();
    const parked = hold(rateLimit(), 'agent');
    expect(parked?.holdMs).toBe(10 * 60_000);
    expect(parked?.reason).toContain('weekly');
    meter.dispose();
  });

  test('the last slice ends at the reset, and a throttle under quota is not parked', async () => {
    const now = 1_000_000;
    const spent = new QuotaMeter(fakeSource([[
      { key: 'five_hour', label: '5h', utilization: 100, resetsAt: now + 90_000 },
    ]]), { now: () => now });
    await spent.refresh();
    expect(quotaProviderHold(spent, undefined, () => now)(rateLimit(), 'agent')?.holdMs).toBe(90_000);
    spent.dispose();

    const healthy = new QuotaMeter(fakeSource([[
      { key: 'five_hour', label: '5h', utilization: 99, resetsAt: now + 90_000 },
    ]]), { now: () => now });
    await healthy.refresh();
    expect(quotaProviderHold(healthy, undefined, () => now)(rateLimit(), 'agent')).toBeUndefined();
    healthy.dispose();
  });
});

describe('review follow-ups', () => {
  test('a watched meter keeps polling through error backoff and recovers', async () => {
    // Real clock: the point is that a timer tick suppressed by the backoff
    // floor re-arms itself instead of leaving the meter with no timer at all.
    const source = fakeSource([new Error('down'), new Error('down'), new Error('down'),
      [{ key: 'five_hour', label: '5h', utilization: 7 }]]);
    const meter = new QuotaMeter(source, { minRefreshIntervalMs: 10, watchIntervalMs: 15 });
    const release = meter.watch();
    await new Promise((r) => setTimeout(r, 600));
    expect(source.calls).toBeGreaterThanOrEqual(4);
    expect(formatQuotaReadout(meter.getSnapshot())).toBe('7% 5h');
    release();
    meter.dispose();
  });

  test('a spent window with no reset time holds one slice on a fresh reading only', async () => {
    let now = 1_000_000;
    const source = fakeSource([[{ key: 'seven_day', label: 'weekly', utilization: 100 }]]);
    const meter = new QuotaMeter(source, { now: () => now });
    await meter.refresh();
    const hook = quotaProviderHold(meter, () => undefined, () => now);
    const hold = hook(rateLimit(), 'resident');
    expect(hold?.holdMs).toBe(10 * 60_000);
    expect(hold?.reason).toContain('reset time not reported');
    now += 2 * HOUR; // the reading is now too old to ground a hold on
    source.fetchWindows = async () => { throw new Error('down'); };
    expect(hook(rateLimit(), 'resident')).toBeUndefined();
    meter.dispose();
  });

  test('the framework-supplied model wins over the recipe model for scoped windows', async () => {
    let now = 1_000_000;
    const source = fakeSource([[{ key: 'seven_day_opus', label: 'opus wk', utilization: 100, resetsAt: now + HOUR, model: 'opus' }]]);
    const meter = new QuotaMeter(source, { now: () => now });
    await meter.refresh();
    const hook = quotaProviderHold(meter, () => 'claude-opus-4-6', () => now);
    expect(hook(rateLimit(), 'subconscious', { model: 'claude-sonnet-5' })).toBeUndefined();
    expect(hook(rateLimit(), 'resident', { model: 'claude-opus-4-6' })?.holdMs).toBe(10 * 60_000);
    expect(hook(rateLimit(), 'resident')?.holdMs).toBe(10 * 60_000); // older framework: no context
    meter.dispose();
  });

  test('numeric resets_at is epoch seconds', () => {
    const [w] = parseAnthropicUsage({ seven_day: { utilization: 100, resets_at: 1790587734 } });
    expect(w!.resetsAt).toBe(1790587734_000);
  });

  test('codex: the keyed codex bucket wins; a foreign legacy bucket is not ours', () => {
    const win = { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1790587734 };
    expect(parseCodexRateLimits({
      rateLimits: { limitId: 'other', primary: { ...win, usedPercent: 99 } },
      rateLimitsByLimitId: { codex: { primary: win, secondary: null } },
    }).map((w) => `${w.utilization}% ${w.label}`)).toEqual(['42% weekly']);
    expect(parseCodexRateLimits({ rateLimits: { limitId: 'other', primary: win } })).toEqual([]);
    expect(parseCodexRateLimits({ rateLimits: { limitName: 'codex', primary: win } })).toHaveLength(1);
  });
});
