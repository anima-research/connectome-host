import { describe, expect, test } from 'bun:test';
import { CredentialMonitor, isAuthFailure, type CredentialSource } from '../src/credential-state.js';
import { QuotaMeter, type QuotaSource, type QuotaWindow } from '../src/quota-meter.js';
import { runPanelOp } from '../src/web/panel-data.js';

const HOUR = 3_600_000;

interface Alert { kind: string; message: string; data: Record<string, unknown> }

function harness(opts: {
  source?: Partial<CredentialSource>;
  meter?: QuotaMeter | null;
  now?: () => number;
  expiryWarningMs?: number;
} = {}) {
  const alerts: Alert[] = [];
  const source: CredentialSource = {
    provider: 'anthropic',
    canRefresh: () => false,
    ...opts.source,
  };
  const monitor = new CredentialMonitor({
    source,
    quotaMeter: opts.meter ?? null,
    modelFor: () => 'claude-fable-5-1',
    alert: (kind, message, data) => alerts.push({ kind, message, data }),
    now: opts.now,
    expiryWarningMs: opts.expiryWarningMs,
  });
  return { monitor, alerts, source };
}

function authErr(message = 'invalid bearer token'): Error {
  return Object.assign(new Error(message), { type: 'auth', httpStatus: 401, retryable: false });
}

function fakeMeter(answers: Array<QuotaWindow[] | Error>, now: () => number): QuotaMeter & { source: QuotaSource & { calls: number } } {
  const source = {
    provider: 'anthropic',
    calls: 0,
    async fetchWindows(): Promise<QuotaWindow[]> {
      const answer = answers[Math.min(source.calls, answers.length - 1)]!;
      source.calls++;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const meter = new QuotaMeter(source, { now, minRefreshIntervalMs: 0 });
  return Object.assign(meter, { source });
}

describe('isAuthFailure', () => {
  test('membrane auth type and bare 401/403 statuses count; nothing else does', () => {
    expect(isAuthFailure(authErr())).toBe(true);
    expect(isAuthFailure({ status: 403 })).toBe(true);
    expect(isAuthFailure({ type: 'rate_limit', httpStatus: 429 })).toBe(false);
    expect(isAuthFailure(new Error('boom'))).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
  });
});

describe('CredentialMonitor — auth verdicts', () => {
  test('starts ok, a 401 becomes auth-rejected with paste + recheck actions when not rotatable', () => {
    const { monitor, alerts } = harness({ source: { setToken: () => {} } });
    expect(monitor.snapshot().kind).toBe('ok');
    monitor.observeError(authErr());
    const s = monitor.snapshot();
    expect(s.kind).toBe('auth-rejected');
    expect(s.rotatable).toBe(false);
    expect(s.actions.map((a) => a.id)).toEqual(['set-token', 'recheck']);
    expect(alerts.map((a) => a.kind)).toEqual(['auth-rejected']);
    expect(alerts[0]!.data.actions).toEqual(s.actions);
    expect(Object.keys(alerts[0]!.data)).not.toContain('token');
  });

  test('an observe-only source (a gateway holds the login) alarms with Re-check only, and refresh/login are refused', async () => {
    const { monitor, alerts } = harness({ source: { provider: 'openai-codex via https://gate.test/codex', canRefresh: () => false } });
    monitor.observeError(authErr('gate: unknown token'));
    const s = monitor.snapshot();
    expect(s.kind).toBe('auth-rejected');
    expect(s.actions.map((a) => a.id)).toEqual(['recheck']);
    expect(alerts[0]!.message).toContain('openai-codex via https://gate.test/codex rejected the credential');
    const refresh = await monitor.runAction('refresh');
    expect(refresh.lastAction).toMatchObject({ id: 'refresh', ok: false });
    expect(refresh.kind).toBe('auth-rejected');
    const login = await monitor.runAction('login');
    expect(login.lastAction).toMatchObject({ id: 'login', ok: false });
    expect(login.kind).toBe('auth-rejected');
    monitor.observeSuccess();
    expect(monitor.snapshot().kind).toBe('ok');
  });

  test('a rotatable source offers refresh first', () => {
    const { monitor } = harness({ source: { canRefresh: () => true, refresh: async () => {}, setToken: () => {} } });
    monitor.observeError(authErr());
    expect(monitor.snapshot().actions.map((a) => a.id)).toEqual(['refresh', 'set-token', 'recheck']);
  });

  test('a known past expiry classifies the 401 as auth-expired', () => {
    const now = () => 1_000_000;
    const { monitor, alerts } = harness({ now, source: { expiresAt: () => now() - 1 } });
    monitor.observeError(authErr());
    expect(monitor.snapshot().kind).toBe('auth-expired');
    expect(alerts[0]!.message).toContain('expired');
  });

  test('non-auth errors leave the state alone; a success clears an auth alarm with a -clear', () => {
    const { monitor, alerts } = harness();
    monitor.observeError(Object.assign(new Error('429'), { type: 'rate_limit' }));
    expect(monitor.snapshot().kind).toBe('ok');
    monitor.observeError(authErr());
    monitor.observeError(authErr());
    expect(alerts.length).toBe(1);
    monitor.observeSuccess();
    expect(monitor.snapshot().kind).toBe('ok');
    expect(alerts.map((a) => a.kind)).toEqual(['auth-rejected', 'auth-rejected-clear']);
  });

  test('device-code login required carries url + code and is not overridden by the 401 it explains', () => {
    const { monitor, alerts } = harness({ source: { provider: 'openai-codex', login: async () => {} } });
    monitor.loginRequired({ verificationUrl: 'https://auth.example/device', userCode: 'ABCD-1234' });
    monitor.observeError(authErr());
    const s = monitor.snapshot();
    expect(s.kind).toBe('auth-login-required');
    expect(s.login).toEqual({ verificationUrl: 'https://auth.example/device', userCode: 'ABCD-1234' });
    expect(alerts[0]!.message).toContain('ABCD-1234');
    expect(s.actions.map((a) => a.id)).toEqual(['login', 'recheck']);
  });
});

describe('CredentialMonitor — expiry warning', () => {
  test('a credential inside the warning window alarms as auth-expiring, and a 401 supersedes it', () => {
    let t = 0;
    const now = () => t;
    const { monitor, alerts } = harness({
      now,
      expiryWarningMs: 10 * 60_000,
      source: { expiresAt: () => 5 * 60_000, canRefresh: () => true, refresh: async () => {} },
    });
    (monitor as unknown as { checkExpiry(): void }).checkExpiry();
    expect(monitor.snapshot().kind).toBe('auth-expiring');
    expect(monitor.snapshot().actions[0]!.id).toBe('refresh');
    t = 6 * 60_000;
    monitor.observeError(authErr());
    expect(monitor.snapshot().kind).toBe('auth-expired');
    expect(alerts.map((a) => a.kind)).toEqual(['auth-expiring', 'auth-expiring-clear', 'auth-expired']);
    expect(alerts[1]!.message).toContain('superseded');
    monitor.dispose();
  });
});

describe('CredentialMonitor — quota meter', () => {
  test('a spent window alarms quota-spent with reset time; the reset clears it', async () => {
    let t = 0;
    const now = () => t;
    const meter = fakeMeter([
      [{ key: 'seven_day', label: 'weekly', utilization: 100, resetsAt: 2 * HOUR }],
      [{ key: 'seven_day', label: 'weekly', utilization: 3, resetsAt: 9 * HOUR }],
    ], now);
    const { monitor, alerts } = harness({ meter, now, source: { setToken: () => {} } });
    await meter.refresh();
    const s = monitor.snapshot();
    expect(s.kind).toBe('quota-spent');
    expect(s.until).toBe(2 * HOUR);
    expect(s.windows).toEqual(['weekly']);
    expect(s.actions.map((a) => a.id)).toEqual(['recheck', 'set-token']);
    t = 2 * HOUR + 1;
    await meter.refresh();
    expect(monitor.snapshot().kind).toBe('ok');
    expect(alerts.map((a) => a.kind)).toEqual(['quota-spent', 'quota-spent-clear']);
    meter.dispose();
    monitor.dispose();
  });

  test('a model-scoped spent window for another model does not alarm', async () => {
    const meter = fakeMeter([[{ key: 'weekly:opus', label: 'opus wk', utilization: 100, resetsAt: HOUR, model: 'opus' }]], () => 0);
    const { monitor } = harness({ meter, now: () => 0 });
    await meter.refresh();
    expect(monitor.snapshot().kind).toBe('ok');
    meter.dispose();
  });

  test('a meter that never reads alarms quota-unreadable after three failures and clears on the first good read', async () => {
    const meter = fakeMeter([new Error('x'), new Error('x'), new Error('usage endpoint answered HTTP 429'), []], () => 0);
    const { monitor, alerts } = harness({ meter, now: () => 0 });
    await meter.refresh();
    await meter.refresh();
    expect(monitor.snapshot().kind).toBe('ok');
    await meter.refresh();
    expect(monitor.snapshot().kind).toBe('quota-unreadable');
    expect(alerts[0]!.message).toContain('HTTP 429');
    await meter.refresh();
    expect(monitor.snapshot().kind).toBe('ok');
    expect(alerts.map((a) => a.kind)).toEqual(['quota-unreadable', 'quota-unreadable-clear']);
    meter.dispose();
  });
});

describe('CredentialMonitor — actions', () => {
  test('refresh on a non-rotatable source fails without changing state', async () => {
    const { monitor } = harness({ source: { setToken: () => {} } });
    monitor.observeError(authErr());
    const s = await monitor.runAction('refresh');
    expect(s.lastAction?.ok).toBe(false);
    expect(s.lastAction?.message).toMatch(/cannot be refreshed/);
    expect(s.kind).toBe('auth-rejected');
  });

  test('refresh + passing probe clears the alarm and reports verified', async () => {
    let refreshed = 0;
    const { monitor, alerts } = harness({
      source: { canRefresh: () => true, refresh: async () => { refreshed++; }, probe: async () => {} },
    });
    monitor.observeError(authErr());
    const s = await monitor.runAction('refresh');
    expect(refreshed).toBe(1);
    expect(s.kind).toBe('ok');
    expect(s.lastAction).toMatchObject({ id: 'refresh', ok: true });
    expect(s.lastAction!.message).toContain('verified');
    expect(alerts.map((a) => a.kind)).toEqual(['auth-rejected', 'auth-rejected-clear']);
  });

  test('a probe that still answers 401 keeps the alarm and reports failure', async () => {
    const { monitor } = harness({
      source: { canRefresh: () => true, refresh: async () => {}, probe: async () => { throw Object.assign(new Error('HTTP 401'), { status: 401 }); } },
    });
    monitor.observeError(authErr());
    const s = await monitor.runAction('refresh');
    expect(s.kind).toBe('auth-rejected');
    expect(s.lastAction?.ok).toBe(false);
    expect(s.message).toContain('still rejects');
  });

  test('an inconclusive probe (429) reports done-but-unverified and leaves the alarm standing', async () => {
    const { monitor } = harness({
      source: { setToken: () => {}, probe: async () => { throw Object.assign(new Error('HTTP 429'), { status: 429 }); } },
    });
    monitor.observeError(authErr());
    const s = await monitor.runAction('set-token', { token: 'sk-ant-new' });
    expect(s.lastAction?.ok).toBe(true);
    expect(s.lastAction?.message).toMatch(/inconclusive/);
    expect(s.kind).toBe('auth-rejected');
  });

  test('set-token needs a token; a source without a probe is cleared optimistically', async () => {
    const seen: string[] = [];
    const { monitor } = harness({ source: { setToken: (t) => { seen.push(t); } } });
    monitor.observeError(authErr());
    expect((await monitor.runAction('set-token', { token: '  ' })).lastAction?.ok).toBe(false);
    const s = await monitor.runAction('set-token', { token: ' sk-ant-new ' });
    expect(seen).toEqual(['sk-ant-new']);
    expect(s.kind).toBe('ok');
    expect(s.lastAction?.message).toMatch(/not verified/);
  });

  test('a throwing refresh is reported, not thrown', async () => {
    const { monitor } = harness({ source: { canRefresh: () => true, refresh: async () => { throw new Error('token endpoint answered HTTP 400 (invalid_grant)'); } } });
    monitor.observeError(authErr());
    const s = await monitor.runAction('refresh');
    expect(s.lastAction).toMatchObject({ ok: false });
    expect(s.lastAction!.message).toContain('invalid_grant');
    expect(s.kind).toBe('auth-rejected');
  });

  test('actions serialize: a paste queued behind a slow refresh still runs with its own token', async () => {
    const order: string[] = [];
    const { monitor } = harness({
      source: {
        canRefresh: () => true,
        refresh: async () => { order.push('refresh:start'); await new Promise((r) => setTimeout(r, 10)); order.push('refresh:end'); },
        setToken: (t) => { order.push(`set:${t}`); },
      },
    });
    const [a, b] = await Promise.all([monitor.runAction('refresh'), monitor.runAction('set-token', { token: 'pasted' })]);
    expect(order).toEqual(['refresh:start', 'refresh:end', 'set:pasted']);
    expect(a.lastAction?.id).toBe('refresh');
    expect(b.lastAction?.id).toBe('set-token');
  });

  test('recheck without a probe leaves a pending login standing (Codex)', async () => {
    const { monitor } = harness({ source: { provider: 'openai-codex', canRefresh: () => true, refresh: async () => {}, login: async () => {} } });
    monitor.loginRequired({ verificationUrl: 'https://auth.example/device', userCode: 'ABCD-1234' });
    const s = await monitor.runAction('recheck');
    expect(s.kind).toBe('auth-login-required');
    expect(s.login?.userCode).toBe('ABCD-1234');
    expect(s.lastAction?.message).toMatch(/state unchanged/);
    const done = await monitor.runAction('login');
    expect(done.kind).toBe('ok');
  });

  test('a refresh whose write to the file fails answers with a state that says so', async () => {
    let monitor!: CredentialMonitor;
    ({ monitor } = harness({
      source: { canRefresh: () => true, refresh: async () => { monitor.observeWriteBack('/x/creds.json', 'EACCES: permission denied'); }, probe: async () => {} },
    }));
    monitor.observeError(authErr());
    const s = await monitor.runAction('refresh');
    expect(s.kind).toBe('ok');
    expect(s.lastAction?.ok).toBe(true);
    expect(s.unsaved).toContain('/x/creds.json');
  });

  test('a restart during a pending login is refused when the source cannot cancel; a later fresh login runs', async () => {
    let release!: () => void;
    let logins = 0;
    const { monitor } = harness({ source: { login: async () => { logins++; if (logins === 1) await new Promise<void>((r) => { release = r; }); } } });
    monitor.loginRequired({ verificationUrl: 'https://x', userCode: 'ABCD' });
    const first = monitor.runAction('login');
    await new Promise((r) => setTimeout(r, 0));
    const refused = await monitor.runAction('login');
    expect(refused.lastAction).toMatchObject({ id: 'login', ok: false });
    expect(refused.lastAction!.message).toContain('already in progress');
    expect(logins).toBe(1);
    release();
    const done = await first;
    expect(done.kind).toBe('ok');
    const fresh = await monitor.runAction('login');
    expect(fresh.lastAction).toMatchObject({ id: 'login', ok: true });
    expect(logins).toBe(2);
  });

  test('a queued restart that arrives after the login it meant to restart succeeded is moot (no logout)', async () => {
    let release!: () => void;
    let logins = 0;
    const source: Partial<CredentialSource> = {
      login: async () => { logins++; if (logins === 1) await new Promise<void>((r) => { release = r; }); },
      cancelLogin: async () => false,
    };
    const { monitor } = harness({ source });
    monitor.loginRequired({ verificationUrl: 'https://x', userCode: 'ABCD' });
    const first = monitor.runAction('login');
    await new Promise((r) => setTimeout(r, 0));
    const restart = monitor.runAction('login');
    release();
    expect((await first).kind).toBe('ok');
    const moot = await restart;
    expect(moot.lastAction).toMatchObject({ id: 'login', ok: true });
    expect(moot.lastAction!.message).toContain('no longer needed');
    expect(logins).toBe(1);
  });

  test('a fresh login from ok or quota-spent always runs: switching a spent Codex account is a login, not a restart', async () => {
    let logins = 0;
    const meter = fakeMeter([[{ key: 'seven_day', label: 'weekly', utilization: 100, resetsAt: 2 * HOUR }]], () => 0);
    const { monitor } = harness({ meter, now: () => 0, source: { login: async () => { logins++; } } });
    await meter.refresh();
    expect(monitor.snapshot().kind).toBe('quota-spent');
    const s = await monitor.runAction('login');
    expect(logins).toBe(1);
    expect(s.lastAction).toMatchObject({ id: 'login', ok: true });
    expect(s.lastAction!.message).not.toContain('no longer needed');
    meter.dispose();
  });

  test('a restart during a pending login cancels it when the source can, and runs a fresh login', async () => {
    let abort!: (e: Error) => void;
    let logins = 0;
    let cancels = 0;
    const source: Partial<CredentialSource> = {
      login: async () => {
        logins++;
        if (logins === 1) await new Promise<void>((_, reject) => { abort = reject; });
      },
      cancelLogin: async () => { cancels++; abort(new Error('login cancelled by the operator')); return true; },
    };
    const { monitor } = harness({ source });
    monitor.loginRequired({ verificationUrl: 'https://x', userCode: 'ABCD' });
    const first = monitor.runAction('login');
    await new Promise((r) => setTimeout(r, 0));
    const second = monitor.runAction('login');
    const firstOutcome = await first;
    expect(firstOutcome.lastAction).toMatchObject({ id: 'login', ok: false });
    expect(firstOutcome.lastAction!.message).toContain('cancelled');
    expect(firstOutcome.kind).toBe('auth-login-required');
    const secondOutcome = await second;
    expect(cancels).toBe(1);
    expect(logins).toBe(2);
    expect(secondOutcome.kind).toBe('ok');
    expect(secondOutcome.lastAction).toMatchObject({ id: 'login', ok: true });
  });

  test('recheck does not clear quota-unreadable while the meter still cannot read', async () => {
    const meter = fakeMeter([new Error('x'), new Error('x'), new Error('x'), new Error('x'), []], () => 0);
    const { monitor } = harness({ meter, now: () => 0, source: { probe: async () => {} } });
    await meter.refresh(); await meter.refresh(); await meter.refresh();
    expect(monitor.snapshot().kind).toBe('quota-unreadable');
    const s = await monitor.runAction('recheck');
    expect(s.kind).toBe('quota-unreadable');
    const s2 = await monitor.runAction('recheck');
    expect(s2.kind).toBe('ok');
    meter.dispose();
  });
});

describe('CredentialMonitor — precedence', () => {
  test('an auth verdict outranks a spent quota, and the quota verdict returns when auth clears', async () => {
    const meter = fakeMeter([[{ key: 'seven_day', label: 'weekly', utilization: 100, resetsAt: 2 * HOUR }]], () => 0);
    const { monitor, alerts } = harness({ meter, now: () => 0, source: { setToken: () => {} } });
    await meter.refresh();
    expect(monitor.snapshot().kind).toBe('quota-spent');
    monitor.observeError(authErr());
    expect(monitor.snapshot().kind).toBe('auth-rejected');
    await meter.refresh();
    expect(monitor.snapshot().kind).toBe('auth-rejected');
    monitor.observeSuccess();
    expect(monitor.snapshot().kind).toBe('quota-spent');
    expect(alerts.map((a) => a.kind)).toEqual([
      'quota-spent', 'quota-spent-clear', 'auth-rejected', 'auth-rejected-clear', 'quota-spent',
    ]);
    expect(alerts[3]!.message).toBe('superseded by quota-spent');
    meter.dispose();
  });

  test('a credential action that verifies while quota is spent settles on quota-spent, never on ok', async () => {
    const meter = fakeMeter([[{ key: 'seven_day', label: 'weekly', utilization: 100, resetsAt: 2 * HOUR }]], () => 0);
    const { monitor, alerts } = harness({ meter, now: () => 0, source: { canRefresh: () => true, refresh: async () => {}, probe: async () => {} } });
    await meter.refresh();
    monitor.observeError(authErr());
    expect(monitor.snapshot().kind).toBe('auth-rejected');
    const s = await monitor.runAction('refresh');
    expect(s.lastAction).toMatchObject({ id: 'refresh', ok: true });
    expect(s.kind).toBe('quota-spent');
    expect(alerts.map((a) => [a.kind, a.message.startsWith('superseded') ? 'superseded' : '']).slice(-2)).toEqual([
      ['auth-rejected-clear', 'superseded'], ['quota-spent', ''],
    ]);
    meter.dispose();
  });

  test('a clean quota read does not clear an expiry warning; a clearing spent window re-raises it', async () => {
    let t = 0;
    const meter = fakeMeter([
      [{ key: 'seven_day', label: 'weekly', utilization: 10, resetsAt: 2 * HOUR }],
      [{ key: 'seven_day', label: 'weekly', utilization: 100, resetsAt: 2 * HOUR }],
      [{ key: 'seven_day', label: 'weekly', utilization: 10, resetsAt: 2 * HOUR }],
    ], () => t);
    const { monitor, alerts } = harness({ meter, now: () => t, expiryWarningMs: 10 * 60_000, source: { expiresAt: () => 5 * 60_000, canRefresh: () => true, refresh: async () => {} } });
    (monitor as unknown as { checkExpiry(): void }).checkExpiry();
    expect(monitor.snapshot().kind).toBe('auth-expiring');
    await meter.refresh();
    expect(monitor.snapshot().kind).toBe('auth-expiring');
    expect(alerts.map((a) => a.kind)).toEqual(['auth-expiring']);
    await meter.refresh();
    expect(monitor.snapshot().kind).toBe('quota-spent');
    await meter.refresh();
    expect(monitor.snapshot().kind).toBe('auth-expiring');
    expect(alerts.map((a) => a.kind)).toEqual(['auth-expiring', 'auth-expiring-clear', 'quota-spent', 'quota-spent-clear', 'auth-expiring']);
    meter.dispose();
    monitor.dispose();
  });

  test('a rotation that moves the expiry out clears a standing auth-expiring warning', () => {
    let expiresAt = 5 * 60_000;
    const { monitor, alerts } = harness({ now: () => 0, expiryWarningMs: 10 * 60_000, source: { expiresAt: () => expiresAt, canRefresh: () => true, refresh: async () => {} } });
    (monitor as unknown as { checkExpiry(): void }).checkExpiry();
    expect(monitor.snapshot().kind).toBe('auth-expiring');
    expiresAt = 3 * HOUR;
    monitor.observeSuccess();
    expect(monitor.snapshot().kind).toBe('ok');
    expect(alerts.map((a) => a.kind)).toEqual(['auth-expiring', 'auth-expiring-clear']);
    expect(alerts[1]!.message).toContain('credential ok');
    monitor.dispose();
  });

  test('after a rotation the state shows the new expiry, and no auth-expiring comes from the old one', () => {
    let t = 0;
    let expiresAt = 20 * 60_000;
    const { monitor, alerts } = harness({ now: () => t, expiryWarningMs: 10 * 60_000, source: { expiresAt: () => expiresAt, canRefresh: () => true, refresh: async () => {} } });
    expect(monitor.snapshot().expiresAt).toBe(20 * 60_000);
    expiresAt = 3 * HOUR;
    monitor.observeSuccess();
    expect(monitor.snapshot().expiresAt).toBe(3 * HOUR);
    t = 15 * 60_000;
    (monitor as unknown as { checkExpiry(): void }).checkExpiry();
    expect(monitor.snapshot().kind).toBe('ok');
    expect(alerts).toEqual([]);
    monitor.dispose();
  });

  test('after a pasted token replaces a refreshable one, the state says the host can no longer refresh it', async () => {
    let refreshable = true;
    const { monitor } = harness({ source: { canRefresh: () => refreshable, setToken: () => { refreshable = false; }, probe: async () => {} } });
    expect(monitor.snapshot().rotatable).toBe(true);
    const s = await monitor.runAction('set-token', { token: 'pasted' });
    expect(s.kind).toBe('ok');
    expect(s.rotatable).toBe(false);
    monitor.dispose();
  });

  test("a quota verdict shows the credential's own expiry, and whether the host can refresh it, as they are when read", async () => {
    let expiresAt = 3 * HOUR;
    let refreshable = true;
    const meter = fakeMeter([[{ key: 'seven_day', label: 'weekly', utilization: 100, resetsAt: 2 * HOUR }]], () => 0);
    const { monitor } = harness({ meter, now: () => 0, source: { expiresAt: () => expiresAt, canRefresh: () => refreshable, refresh: async () => {} } });
    await meter.refresh();
    expect(monitor.snapshot().kind).toBe('quota-spent');
    expect(monitor.snapshot().expiresAt).toBe(3 * HOUR);
    expect(monitor.snapshot().rotatable).toBe(true);
    expiresAt = 5 * HOUR;
    refreshable = false;
    expect(monitor.snapshot().expiresAt).toBe(5 * HOUR);
    expect(monitor.snapshot().rotatable).toBe(false);
    expect(monitor.snapshot().kind).toBe('quota-spent');
    meter.dispose();
    monitor.dispose();
  });

  test('a pending login still says the host can\'t refresh the credential, whatever the source could do otherwise', () => {
    const { monitor } = harness({ source: { canRefresh: () => true, refresh: async () => {}, login: async () => {} } });
    monitor.loginRequired({ verificationUrl: 'https://example.invalid/device', userCode: 'ABCD-1234' });
    expect(monitor.snapshot().kind).toBe('auth-login-required');
    expect(monitor.snapshot().rotatable).toBe(false);
    monitor.dispose();
  });

  test('a passed expiry on an idle host becomes auth-expired without waiting for a 401', () => {
    let t = 0;
    const { monitor, alerts } = harness({ now: () => t, expiryWarningMs: 10 * 60_000, source: { expiresAt: () => 5 * 60_000 } });
    (monitor as unknown as { checkExpiry(): void }).checkExpiry();
    expect(monitor.snapshot().kind).toBe('auth-expiring');
    t = 6 * 60_000;
    (monitor as unknown as { checkExpiry(): void }).checkExpiry();
    expect(monitor.snapshot().kind).toBe('auth-expired');
    expect(alerts.map((a) => a.kind)).toEqual(['auth-expiring', 'auth-expiring-clear', 'auth-expired']);
    monitor.dispose();
  });

  test('bearer() exposes the live token to in-process callers but never a snapshot', () => {
    const { monitor } = harness({ source: { currentToken: () => 'sk-live' } });
    expect(monitor.bearer()).toBe('sk-live');
    expect(JSON.stringify(monitor.snapshot())).not.toContain('sk-live');
  });
});

describe('CredentialMonitor — a credential not written to its file', () => {
  test('each failed write raises credential-unsaved, naming the file and the error and offering a re-check, and leaves the state as it was', () => {
    const { monitor, alerts } = harness({ source: { canRefresh: () => true, refresh: async () => {} } });
    monitor.observeWriteBack('/x/creds.json', 'EACCES: permission denied');
    expect(alerts.map((a) => a.kind)).toEqual(['credential-unsaved']);
    expect(alerts[0]!.message).toContain('/x/creds.json');
    expect(alerts[0]!.message).toContain('EACCES: permission denied');
    expect((alerts[0]!.data.actions as Array<{ id: string }>).map((a) => a.id)).toEqual(['recheck']);
    expect(monitor.snapshot().kind).toBe('ok');
    expect(monitor.snapshot().unsaved).toBe(alerts[0]!.message);
    monitor.observeWriteBack('/x/creds.json', 'EACCES: permission denied');
    expect(alerts.map((a) => a.kind)).toEqual(['credential-unsaved', 'credential-unsaved']);
    monitor.dispose();
  });

  test('it stands beside the credential state, whose alerts go on as before', () => {
    const { monitor, alerts } = harness({ source: { canRefresh: () => true, refresh: async () => {} } });
    monitor.observeError(authErr());
    monitor.observeWriteBack('/x/creds.json', 'EACCES: permission denied');
    expect(monitor.snapshot().kind).toBe('auth-rejected');
    monitor.observeSuccess();
    expect(monitor.snapshot().kind).toBe('ok');
    expect(monitor.snapshot().unsaved).toBeDefined();
    expect(alerts.map((a) => a.kind)).toEqual(['auth-rejected', 'credential-unsaved', 'auth-rejected-clear']);
    monitor.dispose();
  });

  test('the next write that succeeds clears it once; one with nothing standing raises nothing', () => {
    const { monitor, alerts } = harness();
    monitor.observeWriteBack('/x/creds.json');
    expect(alerts).toEqual([]);
    monitor.observeWriteBack('/x/creds.json', 'EACCES: permission denied');
    monitor.observeWriteBack('/x/creds.json');
    monitor.observeWriteBack('/x/creds.json');
    expect(alerts.map((a) => a.kind)).toEqual(['credential-unsaved', 'credential-unsaved-clear']);
    expect(alerts[1]!.message).toContain('/x/creds.json');
    expect(monitor.snapshot().unsaved).toBeUndefined();
    monitor.dispose();
  });

  test('/auth recheck writes the credential again while the alert stands, and only then', async () => {
    let writable = false;
    let writes = 0;
    let monitor!: CredentialMonitor;
    let alerts!: Alert[];
    ({ monitor, alerts } = harness({
      source: {
        probe: async () => {},
        writeBack: () => { writes++; monitor.observeWriteBack('/x/creds.json', writable ? undefined : 'EACCES: permission denied'); },
      },
    }));
    monitor.observeWriteBack('/x/creds.json', 'EACCES: permission denied');
    const still = await monitor.runAction('recheck');
    expect(writes).toBe(1);
    expect(still.unsaved).toBeDefined();
    writable = true;
    const fixed = await monitor.runAction('recheck');
    expect(writes).toBe(2);
    expect(fixed.unsaved).toBeUndefined();
    expect(alerts.at(-1)!.kind).toBe('credential-unsaved-clear');
    await monitor.runAction('recheck');
    expect(writes).toBe(2);
    monitor.dispose();
  });
});

describe('panel ops', () => {
  function panelApp(monitor: CredentialMonitor | null) {
    return {
      framework: { getAllAgents: () => [], healthSnapshot: () => ({ agents: [] }) } as never,
      recipe: { agent: { name: 'commander' } } as never,
      credentials: monitor,
    };
  }

  test('credential answers subscription:false on an API-key host and refuses actions', async () => {
    expect(await runPanelOp(panelApp(null), 'credential')).toEqual({ ok: true, data: { subscription: false } });
    const r = await runPanelOp(panelApp(null), 'credential-action', { action: 'recheck' });
    expect(r.ok).toBe(false);
    expect((r as { status?: number }).status).toBe(404);
  });

  test('credential-action validates the action and runs it; health carries the state', async () => {
    const { monitor } = harness({ source: { setToken: () => {} } });
    monitor.observeError(authErr());
    const app = panelApp(monitor);
    const bad = await runPanelOp(app, 'credential-action', { action: 'nuke' });
    expect(bad.ok).toBe(false);
    const noToken = await runPanelOp(app, 'credential-action', { action: 'set-token' });
    expect(noToken.ok).toBe(false);
    const ok = await runPanelOp(app, 'credential-action', { action: 'set-token', token: 'sk-ant-new' });
    expect(ok.ok).toBe(true);
    expect((ok as { data: Record<string, unknown> }).data).toMatchObject({ subscription: true, agent: 'commander', kind: 'ok' });
    expect(JSON.stringify(ok)).not.toContain('sk-ant-new');
    const health = await runPanelOp(app, 'health');
    expect((health as { data: { credential?: { kind: string; agent: string } } }).data.credential).toMatchObject({ kind: 'ok', agent: 'commander' });
  });
});
