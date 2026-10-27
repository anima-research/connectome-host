import { describe, expect, test } from 'bun:test';
import { CREDENTIAL_STRINGS, HEALTH_STRINGS, QUOTA_STRINGS, keepNamedStrings, type KeptStrings } from '../src/modules/web-ui-observers.js';
import { PAGE_WAYS, bannerOf, restartLines, statusLines, type UpdateStatus } from '../src/web/update-text.js';
import { credentialNote, healthEntry, healthReadError, lastActionText, readFailureLine } from '../src/web/health-lookup.js';
import { debtNextStep, debtSummary, debtTone, type CompressionDebt } from '../src/web/compression-debt.js';
import type { CallLedgerRow, QuotaSnapshotData } from '../src/web/protocol.js';
import { planHealthAlerts } from '../web/src/health-alerts';
import { callFailed } from '../web/src/call-origin';
import { quotaTitle, quotaUnreadable } from '../web/src/quota';
import type { HealthSnapshot } from '../web/src/Health';

const TEXT = {
  call: 'overloaded_error: the provider is overloaded',
  lastError: 'the last turn failed: overloaded_error',
  debt: 'The compression report failed.\nCause: the store said no.',
  read: 'the store refused the read',
  quota: 'the usage endpoint answered 500',
  credential: 'anthropic rejected the credential (invalid x-api-key)',
  action: 'refresh failed: the token endpoint answered 400',
};

const sent = <T>(value: T, kept: KeptStrings | null): T =>
  JSON.parse(JSON.stringify(kept ? keepNamedStrings(value, kept) : value)) as T;

const row = (over: Partial<CallLedgerRow>): CallLedgerRow => ({
  id: 'c', timestamp: '2026-10-22T06:00:00.000Z', kind: 'stream', originEstimate: 'turn~', model: 'a-model',
  messages: 3, durationMs: 10, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  cache: { ttls: ['5m'], effectiveTtl: '5m' }, verdict: 'HIT', cause: '90% from cache', ...over,
});

const health = {
  agents: [{
    name: 'main',
    status: 'idle',
    consecutiveInferenceFailures: 3,
    lastInference: { startedAt: 1, failedAt: 2, lastError: TEXT.lastError },
  }],
  compressionQuarantine: {
    main: { count: 1, keys: ['q1'], spans: [{ chunkSourceHash: 'h1', firstMessageId: 'm1', lastMessageId: 'm2', quarantinedAt: 1, records: 1, latestOutcome: 'refusal' }] },
  },
  compressionDebt: { main: { state: 'unknown', error: TEXT.debt, failure: 'report', pendingChunks: null } },
  readFailures: { main: { contextComposition: TEXT.read } },
  callLedger: {
    rows: [row({ id: 'c1', verdict: 'ERROR', cause: TEXT.call, error: TEXT.call }), row({ id: 'c2' })],
    summary: { calls: 2, input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cacheHitRatio: 0, byVerdict: { ERROR: 1, HIT: 1 } },
  },
};

describe('the health panel, with health and without ops', () => {
  const whole = sent(health, null) as unknown as HealthSnapshot & { callLedger: { rows: CallLedgerRow[] } };
  const bare = sent(health, HEALTH_STRINGS) as typeof whole;

  test('the snapshot it gets carries none of the failure text', () => {
    const json = JSON.stringify(bare);
    for (const text of [TEXT.call, TEXT.lastError, TEXT.debt, TEXT.read]) {
      expect(json).not.toContain(JSON.stringify(text).slice(1, -1));
    }
  });

  test("an agent that is down is still down, without its last error's text", () => {
    const exhausted = (h: HealthSnapshot) => planHealthAlerts(h, new Map()).upsert.find((u) => u.kind === 'inference-exhausted')?.message;
    expect(exhausted(whole)).toBe(`3 consecutive inference failures — agent is down. Last: ${TEXT.lastError}`);
    expect(exhausted(bare)).toBe('3 consecutive inference failures — agent is down.');
    const quarantine = (h: HealthSnapshot) => planHealthAlerts(h, new Map()).upsert.find((u) => u.kind === 'compression-quarantine')?.message;
    expect(quarantine(bare)).toBe(quarantine(whole));
  });

  test("a section whose read failed still says so, and the debt line says it can't be checked, without what the errors said", () => {
    const failed = healthEntry(bare.readFailures, 'main')!;
    expect(Object.keys(failed)).toEqual(['contextComposition']);
    expect(readFailureLine('contextComposition', failed.contextComposition!)).toBe("contextComposition couldn't be read");
    expect(readFailureLine('contextComposition', healthEntry(whole.readFailures, 'main')!.contextComposition!))
      .toBe(`contextComposition couldn't be read: ${TEXT.read}`);
    const debt = (h: HealthSnapshot) => healthEntry(h.compressionDebt, 'main') as CompressionDebt;
    expect(debtSummary(debt(bare))).toBe(debtSummary(debt(whole)));
    expect(debtTone(debt(bare))).toBe(debtTone(debt(whole)));
    expect(debtNextStep(debt(whole))).toBeDefined();
    expect(debtNextStep(debt(bare))).toBeUndefined();
  });

  test('a /healthz read that failed whole still shows as failed, by its status when its error comes empty', () => {
    expect(healthReadError(500, { error: TEXT.read })).toBe(TEXT.read);
    expect(healthReadError(500, { error: '' })).toBe('HTTP 500');
    expect(healthReadError(502, null)).toBe('HTTP 502');
    expect(healthReadError(503, { error: 7 })).toBe('HTTP 503');
  });

  test('a failed call is still a failed call, and a cache hit keeps its cause', () => {
    expect(bare.callLedger.rows.map(callFailed)).toEqual([true, false]);
    expect(whole.callLedger.rows.map(callFailed)).toEqual([true, false]);
    expect(bare.callLedger.rows.map((r) => [r.verdict, r.cause])).toEqual([['ERROR', ''], ['HIT', '90% from cache']]);
  });

  test("a quota that couldn't be read still reads as unreadable, without what the read said", () => {
    const quota: QuotaSnapshotData = { subscription: true, provider: 'anthropic', windows: [], fetchedAt: 1, error: TEXT.quota };
    const bareQuota = sent(quota, QUOTA_STRINGS);
    expect(bareQuota.error).toBe('');
    expect(quotaUnreadable(bareQuota)).toBe(true);
    expect(quotaUnreadable(quota)).toBe(true);
    expect(quotaUnreadable({ ...quota, error: undefined })).toBe(false);
    expect(quotaTitle(bareQuota)).toBe('Subscription quota (anthropic)\nLast refresh failed');
    expect(quotaTitle(quota)).toBe(`Subscription quota (anthropic)\nLast refresh failed: ${TEXT.quota}`);
    expect(quotaUnreadable(null)).toBe(false);
    const kept = { ...bareQuota, windows: [{ key: 'five_hour', label: '5h', utilization: 10 }] };
    expect(quotaUnreadable(kept)).toBe(false);
    expect(quotaTitle(kept)).toBe('Subscription quota (anthropic)\n5h: 10% used\nLast refresh failed');
    expect(quotaTitle({ ...kept, error: undefined })).toBe('Subscription quota (anthropic)\n5h: 10% used');
  });

  test("the credential still shows its kind, its login and how its last action ended, without what either said", () => {
    const credential = {
      subscription: true, kind: 'auth-rejected', provider: 'anthropic', message: TEXT.credential, since: 1, rotatable: true,
      actions: [{ id: 'refresh', label: 'Refresh' }], login: { verificationUrl: 'https://example.invalid/device', userCode: 'ABCD-1234' },
      lastAction: { id: 'refresh', at: 2, ok: false, message: TEXT.action },
    };
    const bare = sent(credential, CREDENTIAL_STRINGS);
    expect(JSON.stringify(bare)).not.toContain(TEXT.credential);
    expect(JSON.stringify(bare)).not.toContain(TEXT.action);
    expect(bare).toMatchObject({ kind: 'auth-rejected', login: credential.login, actions: credential.actions });
    expect(credentialNote(credential)).toBe(TEXT.credential);
    expect(credentialNote(bare)).toBeUndefined();
    expect(credentialNote({ ...credential, kind: 'ok' })).toBeUndefined();
    expect(credentialNote({ message: TEXT.credential })).toBeUndefined();
    expect(lastActionText(credential.lastAction, '5s ago')).toBe(`refresh FAILED 5s ago — ${TEXT.action}`);
    expect(lastActionText(bare.lastAction, '5s ago')).toBe('refresh FAILED 5s ago');
    expect(lastActionText({ id: 'recheck', ok: true, message: 'credential verified' }, '5s ago')).toBe('recheck ok 5s ago — credential verified');
    expect(lastActionText({ id: 'recheck', ok: true, message: '' }, '5s ago')).toBe('recheck ok 5s ago');
  });
});

describe("the update section, with health and without ops", () => {
  const update: UpdateStatus = {
    running: '0.12.1', install: true, checks: true,
    check: { at: '2026-10-22T12:00:00.000Z', ok: true, candidate: '0.13.0', costs: [{ version: '0.13.0', breaking: true, cacheWrite: null }], bunFloorUnmet: '>=1.5.0', runningDeprecated: 'use 0.12.2: a store bug' },
    installing: '0.13.1',
    lastInstall: { version: '0.13.0', at: '2026-10-22T12:01:00.000Z', ok: false, error: 'npm exited 1: E404 the registry said no' },
    installed: '0.12.2',
    goBack: { to: '0.12.0', since: '2026-10-20T10:00:00.000Z' },
    restart: {
      to: '0.12.2', why: 'update', keepData: false, phase: 'busy',
      hosts: [
        { host: 'this host', answered: true, drained: false, activeTurnAgents: ['alice'], backgroundScripts: 1 },
        { host: 'kid', answered: false, why: 'the socket said ECONNRESET' },
      ],
    },
    operatorQuiesced: 'maintenance: disk swap tonight',
    switchQuiesceLeft: false,
    lastSwitch: { outcome: 'refused', step: 'children-check', from: '0.12.1', to: '0.12.2', at: '2026-10-21T09:00:00.000Z', reason: 'fleet children are still running: kid (pid 4242, ANTHROPIC_API_KEY sk-ant-xyz)' },
    problems: ["the last switch: Line 3 of the journal at /srv/root/journal.jsonl isn't JSON"],
  };
  const bare = sent({ update }, HEALTH_STRINGS).update;

  test('keeps the versions, times and names, and empties every reason, error and message', () => {
    expect(bare).toEqual({
      ...update,
      check: { ...update.check!, runningDeprecated: '' } as UpdateStatus['check'],
      lastInstall: { ...update.lastInstall!, error: '' },
      restart: { ...update.restart!, hosts: [update.restart!.hosts[0]!, { host: 'kid', answered: false, why: '' }] },
      operatorQuiesced: '',
      lastSwitch: { ...update.lastSwitch!, reason: '' },
      problems: [''],
    });
  });

  test("a fallback keeps its versions and time, and empties the lines its trial kept", () => {
    const fellBack: UpdateStatus = {
      ...update,
      lastSwitch: {
        outcome: 'fell-back', from: '0.12.1', to: '0.12.2', at: '2026-10-21T09:00:00.000Z', reason: '0.12.2 ended before its commit',
        trialLog: ['Fatal error: Error: ANTHROPIC_API_KEY sk-ant-xyz was refused'],
      },
    };
    expect(sent({ update: fellBack }, HEALTH_STRINGS).update.lastSwitch).toEqual({
      outcome: 'fell-back', from: '0.12.1', to: '0.12.2', at: '2026-10-21T09:00:00.000Z', reason: '', trialLog: [''],
    });
  });

  test("a read that failed keeps its time and empties its error", () => {
    const failed: UpdateStatus = { ...update, check: { at: '2026-10-22T12:00:00.000Z', ok: false, error: 'getaddrinfo ENOTFOUND registry.internal.example' } };
    expect(sent({ update: failed }, HEALTH_STRINGS).update.check).toEqual({ at: '2026-10-22T12:00:00.000Z', ok: false, error: '' });
  });

  const secrets = ['E404', 'ECONNRESET', 'disk swap', 'sk-ant', 'journal.jsonl', 'store bug', 'ENOTFOUND', 'refused'];
  const words = (status: UpdateStatus): string => {
    const shown = sent({ update: status }, HEALTH_STRINGS).update;
    return [...statusLines(shown, PAGE_WAYS), ...(restartLines(shown) ?? []), bannerOf(shown)?.line ?? ''].join('\n');
  };

  test("the page's words keep each fact, with no clause for the text emptied from it", () => {
    const text = words(update);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).toContain("- kid: can't be counted\n");
    expect(text).toContain('This host is quiesced: a restart, or a Go back that keeps the data, keeps it so.');
    expect(text).toContain("Last request: to 0.12.2, didn't go ahead at 2026-10-21T09:00:00.000Z.");
    expect(text).toContain("1 part of this status couldn't be read.");
    expect(text).toContain('This host is quiesced, and comes back quiesced.');
    const failedInstall = words({ ...update, installing: null, restart: null });
    expect(failedInstall).toContain('Installing 0.13.0 failed.');
    expect(failedInstall).toContain("0.12.2 is installed, and the last request to switch to it didn't go ahead.");
    expect(words({ ...update, check: { at: '2026-10-22T12:00:00.000Z', ok: false, error: 'getaddrinfo ENOTFOUND' } }))
      .toContain('Reading the registry failed at 2026-10-22T12:00:00.000Z.\n');
    const deprecated = { ...update.check!, candidate: null, costs: [] } as UpdateStatus['check'];
    expect(words({ ...update, check: deprecated })).toContain('0.12.1 is deprecated on npm.\n');
    const quiet: UpdateStatus = { ...update, check: deprecated, restart: null, installing: null, installed: null, lastInstall: null };
    expect(bannerOf(sent({ update: quiet }, HEALTH_STRINGS).update)?.line).toBe('0.12.1 is deprecated on npm.');
    const two: UpdateStatus = { ...update, problems: ['the last switch: EACCES on journal.jsonl', 'the copy: ENOENT'] };
    expect(words(two)).toContain("2 parts of this status couldn't be read.");
    expect(words({ ...two, install: false })).toContain("2 parts of this status couldn't be read.");
  });

  test("a fallback's emptied lines read as none, pointing at the service's log", () => {
    const fellBack: UpdateStatus = {
      ...update, restart: null, installing: null,
      lastSwitch: {
        outcome: 'fell-back', from: '0.12.1', to: '0.12.2', at: '2026-10-21T09:00:00.000Z', reason: '0.12.2 refused its store',
        trialLog: ['Fatal error: Error: ANTHROPIC_API_KEY sk-ant-xyz was refused'],
      },
    };
    const text = words(fellBack);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).toContain('Last switch: 0.12.1 came back with its data at 2026-10-21T09:00:00.000Z, from a try of 0.12.2. ' +
      "The service's log, or the terminal the host was started in, says more.");
    expect(text).toContain("0.12.2 ended before its commit at its last try, so 0.12.1 came back. The service's log, or the " +
      'terminal the host was started in, says more.');
    expect(text).toContain("Its last try ended before its commit. The service's log, or the terminal the host was started " +
      'in, says more.');
  });
});
