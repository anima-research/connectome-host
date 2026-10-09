/**
 * Credential monitor — turns what the host can observe about its provider
 * credential (provider errors, quota-meter readings, token expiry metadata,
 * a pending device-code login) into ONE named state, and moves that state
 * through the ops-alert pipeline (failures.log + `ops:alert` trace + webhook)
 * so the TUI status bar, the WebUI alert strip and fleet parents all learn
 * about it on the wire they already watch.
 *
 * The alert payload carries the operator actions the host can run for that
 * state (`refresh`, `login`, `set-token`, `recheck`). Nothing here runs an
 * action on its own: the operator clicks (WebUI) or types `/auth …` (TUI),
 * the panel op `credential-action` lands on `runAction`, and the resulting
 * state is announced the same way. Membrane's own single 401 retry with
 * `forceRefresh` is the only automatic rotation, and each source decides
 * whether it honours that (see AnthropicOAuthCredentials.autoRefresh).
 *
 * Why not just wait for hard-down: a 401 is non-retryable, so the framework
 * records one failed turn per wake and only alarms after three; nothing in
 * that path says "auth", and nothing offers a fix. A spent subscription
 * window parks the agent BEFORE inference, so no failure is ever seen by
 * anyone but the provider-hold hook. Both are silent to the humans who
 * pinged the agent — see ActivityModule's jam notices.
 */

import type { QuotaMeter, QuotaSnapshot } from './quota-meter.js';

export type CredentialStateKind =
  | 'ok'
  | 'quota-spent'
  | 'quota-unreadable'
  | 'auth-expiring'
  | 'auth-expired'
  | 'auth-rejected'
  | 'auth-login-required';

export type CredentialActionId = 'refresh' | 'login' | 'set-token' | 'recheck';

export interface CredentialAction {
  id: CredentialActionId;
  /** Button / command label. */
  label: string;
  /** One line of operator guidance, e.g. what to paste. */
  hint?: string;
}

/** The wire shape (health snapshot, `credential` panel op, alert data). Never
 *  carries a token. */
export interface CredentialState {
  kind: CredentialStateKind;
  provider: string;
  /** Operator-facing one-liner; also the alert message. */
  message: string;
  /** Epoch ms the current state was entered. */
  since: number;
  /** Epoch ms the condition is expected to lift by itself (quota reset,
   *  token expiry for `auth-expiring`), when known. */
  until?: number;
  /** Spent window labels (`weekly`, `5h`, …) for `quota-spent`. */
  windows?: string[];
  /** The source can rotate the credential without operator input. */
  rotatable: boolean;
  /** Epoch ms of the credential's own expiry, when the source knows it. */
  expiresAt?: number;
  /** Actions the host can run for this state, in the order to offer them. */
  actions: CredentialAction[];
  /** Device-code login in progress (`auth-login-required`). */
  login?: { verificationUrl: string; userCode: string };
  /** Outcome of the last operator action, for the panel. */
  lastAction?: { id: CredentialActionId; at: number; ok: boolean; message: string };
}

/**
 * What the host implements per provider. Every method is optional except the
 * identity: a source that can do nothing still yields useful alerts (the
 * operator learns WHAT is wrong even when the only fix is a restart).
 */
export interface CredentialSource {
  readonly provider: string;
  /** True when `refresh()` can rotate without operator input. */
  canRefresh(): boolean;
  /** Rotate the credential (refresh token, app-server refresh). Rejects on failure. */
  refresh?(): Promise<void>;
  /** Start an interactive login; resolves when it completes. */
  login?(): Promise<void>;
  /** Replace the credential with one the operator pasted. */
  setToken?(token: string): Promise<void> | void;
  /** Epoch ms the current credential expires, when known. */
  expiresAt?(): number | undefined;
  /**
   * Cheap validity check that costs no inference (usage endpoint, account
   * read). Resolves on success; rejects with `{ status?: number }` on
   * failure — only 401/403 count as an auth verdict, anything else is
   * inconclusive (the KR-class inference-only token answers 429 here).
   */
  probe?(): Promise<void>;
  /** The live bearer, for in-process callers that must send the same
   *  credential as inference (count_tokens). Never put in a snapshot. */
  currentToken?(): string | undefined;
  /** A rotation that took effect in memory but could not be persisted —
   *  reported with the action outcome so the operator knows a restart
   *  would reload the old credential. */
  persistWarning?(): string | undefined;
}

export interface CredentialMonitorOptions {
  source: CredentialSource;
  /** Subscription meter, when the host runs on one. */
  quotaMeter?: QuotaMeter | null;
  /** Model the meter's model-scoped windows are matched against. */
  modelFor?: () => string | undefined;
  /** Sink for state transitions — the host wires notifyOpsAlert. */
  alert: (kind: string, message: string, data: Record<string, unknown>) => void;
  now?: () => number;
  /** Warn this long before a known expiry (default 30 min). */
  expiryWarningMs?: number;
  /** A meter that has never read successfully alarms after this many
   *  consecutive failed reads (default 3). */
  unreadableAfterErrors?: number;
}

/** Alert kinds whose presence means the agent cannot answer right now. */
export const JAM_ALERT_KINDS: ReadonlySet<string> = new Set([
  'quota-spent',
  'auth-expired',
  'auth-rejected',
  'auth-login-required',
]);

const DEFAULT_EXPIRY_WARNING_MS = 30 * 60_000;
const DEFAULT_UNREADABLE_AFTER = 3;
/** A meter error this old is stale news, not a live condition. */
const EXPIRING_RECHECK_MS = 60_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

/** Membrane's typed auth verdict, or a bare HTTP 401/403 from another layer. */
export function isAuthFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.type === 'auth') return true;
  const status = error.httpStatus ?? error.status;
  return status === 401 || status === 403;
}

export class CredentialMonitor {
  private readonly source: CredentialSource;
  private readonly meter: QuotaMeter | null;
  private readonly modelFor: () => string | undefined;
  private readonly alert: CredentialMonitorOptions['alert'];
  private readonly now: () => number;
  private readonly expiryWarningMs: number;
  private readonly unreadableAfter: number;
  private state: CredentialState;
  private meterErrors = 0;
  /** The meter's standing verdict (quota-spent / quota-unreadable), kept
   *  aside while an auth state has precedence and re-applied when it lifts. */
  private meterVerdict: PendingState | null = null;
  private unsubMeter: (() => void) | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private actionChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: CredentialMonitorOptions) {
    this.source = options.source;
    this.meter = options.quotaMeter ?? null;
    this.modelFor = options.modelFor ?? (() => undefined);
    this.alert = options.alert;
    this.now = options.now ?? Date.now;
    this.expiryWarningMs = options.expiryWarningMs ?? DEFAULT_EXPIRY_WARNING_MS;
    this.unreadableAfter = options.unreadableAfterErrors ?? DEFAULT_UNREADABLE_AFTER;
    this.state = this.okState();
    if (this.meter) {
      this.unsubMeter = this.meter.onChange((snapshot) => this.observeMeter(snapshot));
      const current = this.meter.getSnapshot();
      if (current) this.observeMeter(current);
    }
    this.armExpiryTimer();
  }

  get provider(): string {
    return this.source.provider;
  }

  snapshot(): CredentialState {
    return { ...this.state, actions: [...this.state.actions] };
  }

  /** The live bearer for in-process callers (count_tokens must authenticate
   *  exactly as inference does). Not part of any snapshot or alert. */
  bearer(): string | undefined {
    try {
      return this.source.currentToken?.();
    } catch {
      return undefined;
    }
  }

  /** Auth states outrank meter states: an expired token is actionable, a
   *  spent window is a wait. `auth-expiring` is a warning and yields. */
  private authHasPrecedence(): boolean {
    return this.state.kind.startsWith('auth-') && this.state.kind !== 'auth-expiring';
  }

  /** Show the meter's verdict, or ok, unless an auth state outranks it. A
   *  clean quota read is not news about the credential's expiry: an
   *  `auth-expiring` warning stands until the token rotates or expires, and
   *  is re-raised when a spent window clears while the token is still short. */
  private applyMeterVerdict(): void {
    if (this.authHasPrecedence()) return;
    if (this.meterVerdict) {
      this.transition(this.meterVerdict);
      return;
    }
    if (this.state.kind === 'auth-expiring') return;
    this.transition(this.okState());
    this.checkExpiry();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubMeter?.();
    this.unsubMeter = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Observations
  // ---------------------------------------------------------------------------

  /** A provider call failed. Only auth verdicts change state here; rate
   *  limits are the meter's business (the hold hook already kicks a read). */
  observeError(error: unknown): void {
    if (this.disposed) return;
    if (!isAuthFailure(error)) return;
    // A device-code login already in progress explains the rejection.
    if (this.state.kind === 'auth-login-required') return;
    const expiresAt = this.expiry();
    const expired = expiresAt !== undefined && expiresAt <= this.now();
    const detail = isRecord(error) && typeof error.message === 'string' ? error.message : 'authentication rejected';
    this.transition({
      kind: expired ? 'auth-expired' : 'auth-rejected',
      message: expired
        ? `${this.source.provider} credential expired ${new Date(expiresAt).toISOString()} — the provider rejects it (${trim(detail)})`
        : `${this.source.provider} rejected the credential (${trim(detail)})`,
      rotatable: this.source.canRefresh(),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      actions: this.authActions(),
    });
  }

  /** A provider call succeeded: whatever auth state we held is over; the
   *  meter's standing verdict (if any) shows again — directly, never via an
   *  intermediate `ok`, which would read as recovery while quota still blocks. */
  observeSuccess(): void {
    if (this.disposed) return;
    if (this.authHasPrecedence()) this.settleAfterAuth();
  }

  /** Leave an auth state for whatever stands beneath it: the meter's verdict,
   *  else the expiry warning if the token is short, else ok. One transition. */
  private settleAfterAuth(): void {
    if (this.meterVerdict) {
      this.transition(this.meterVerdict);
      return;
    }
    this.transition(this.okState());
    this.checkExpiry();
  }

  /** The Codex app-server needs a human at a browser. */
  loginRequired(details: { verificationUrl: string; userCode: string }): void {
    if (this.disposed) return;
    this.transition({
      kind: 'auth-login-required',
      message: `${this.source.provider} login required — open ${details.verificationUrl} and enter code ${details.userCode}`,
      rotatable: false,
      login: { ...details },
      actions: [
        { id: 'login', label: 'Restart login', hint: 'Starts a new device-code login and shows a fresh code.' },
        { id: 'recheck', label: 'Re-check' },
      ],
    });
  }

  private observeMeter(snapshot: QuotaSnapshot): void {
    if (this.disposed || !this.meter) return;
    const model = this.modelFor();
    const spent = this.meter.spentWindows(model);
    const until = this.meter.blockedUntil(model);
    if (spent.length > 0 && (until !== undefined || this.meter.spentWithUnknownReset(model))) {
      const labels = spent.map((w) => w.label);
      this.meterVerdict = {
        kind: 'quota-spent',
        message: `${this.source.provider} subscription quota spent (${labels.join(', ')}) — ` +
          (until !== undefined ? `resets ${new Date(until).toISOString()}` : 'reset time not reported'),
        rotatable: this.source.canRefresh(),
        windows: labels,
        ...(until !== undefined ? { until } : {}),
        actions: [
          { id: 'recheck', label: 'Re-read quota' },
          ...(this.source.setToken ? [{ id: 'set-token' as const, label: 'Use another token', hint: 'Paste a token from a different subscription.' }] : []),
        ],
      };
      this.applyMeterVerdict();
      return;
    }
    if (snapshot.error && snapshot.fetchedAt === 0) {
      this.meterErrors++;
      if (this.meterErrors >= this.unreadableAfter) {
        this.meterVerdict = {
          kind: 'quota-unreadable',
          message: `${this.source.provider} quota cannot be read (${trim(snapshot.error)}) — ` +
            'no spent-quota hold is possible for this credential; a 429 will be retried as a throttle',
          rotatable: this.source.canRefresh(),
          actions: [{ id: 'recheck', label: 'Re-read quota' }],
        };
        this.applyMeterVerdict();
      }
      return;
    }
    if (!snapshot.error) {
      this.meterErrors = 0;
      this.meterVerdict = null;
      this.applyMeterVerdict();
    }
    // A failed read on a snapshot that HAS windows keeps the previous verdict
    // (stale windows are still the best information; the meter says so).
  }

  private checkExpiry(): void {
    if (this.disposed) return;
    const expiresAt = this.expiry();
    this.armExpiryTimer();
    if (expiresAt === undefined) return;
    const remaining = expiresAt - this.now();
    if (remaining > this.expiryWarningMs) return;
    if (remaining <= 0) {
      // The credential's own expiry passed on an idle host: say so now
      // instead of repeating "expires in ~1 min" until a 401 proves it.
      if (this.state.kind !== 'ok' && this.state.kind !== 'auth-expiring') return;
      this.transition({
        kind: 'auth-expired',
        message: `${this.source.provider} credential expired ${new Date(expiresAt).toISOString()} — the next call will be rejected`,
        rotatable: this.source.canRefresh(),
        expiresAt,
        actions: this.authActions(),
      });
      return;
    }
    if (this.state.kind !== 'ok' && this.state.kind !== 'auth-expiring') return;
    const minutes = Math.max(1, Math.round(remaining / 60_000));
    this.transition({
      kind: 'auth-expiring',
      message: `${this.source.provider} credential expires in ~${minutes} min (${new Date(expiresAt).toISOString()})`,
      rotatable: this.source.canRefresh(),
      until: expiresAt,
      expiresAt,
      actions: this.authActions(),
    });
  }

  private armExpiryTimer(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.disposed) return;
    const expiresAt = this.expiry();
    if (expiresAt === undefined) return;
    const warnAt = expiresAt - this.expiryWarningMs;
    const delay = Math.max(1_000, Math.min(warnAt - this.now(), EXPIRING_RECHECK_MS * 60));
    // Past the warning threshold, re-check every minute so the countdown in
    // the message stays roughly honest without spamming transitions.
    const wait = warnAt <= this.now() ? EXPIRING_RECHECK_MS : delay;
    this.expiryTimer = setTimeout(() => this.checkExpiry(), wait);
    this.expiryTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Run one operator action. Serialized, not coalesced: a request that
   * arrives while another runs queues behind it and runs with its own
   * parameters (a pasted token must never be swallowed by a slow refresh).
   * Never throws — the outcome lands in `lastAction` and the state moves
   * accordingly.
   */
  runAction(id: CredentialActionId, params: { token?: string } = {}): Promise<CredentialState> {
    const run = this.actionChain.then(() => this.performAction(id, params));
    this.actionChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async performAction(id: CredentialActionId, params: { token?: string }): Promise<CredentialState> {
    const at = this.now();
    const done = (ok: boolean, message: string): CredentialState => {
      this.state = { ...this.state, lastAction: { id, at, ok, message } };
      return this.snapshot();
    };
    try {
      switch (id) {
        case 'refresh': {
          if (!this.source.refresh || !this.source.canRefresh()) {
            return done(false, `${this.source.provider} credential cannot be refreshed by the host — paste a new token instead`);
          }
          await this.source.refresh();
          return done(...(await this.settle('refreshed', id)));
        }
        case 'login': {
          if (!this.source.login) return done(false, `${this.source.provider} has no interactive login`);
          await this.source.login();
          return done(...(await this.settle('login completed', id)));
        }
        case 'set-token': {
          if (!this.source.setToken) return done(false, `${this.source.provider} credential cannot be replaced at runtime`);
          const token = typeof params.token === 'string' ? params.token.trim() : '';
          if (!token) return done(false, 'set-token needs a non-empty token');
          await this.source.setToken(token);
          return done(...(await this.settle('token replaced', id)));
        }
        case 'recheck': {
          // Awaited: the meter's fresh verdict is part of the answer.
          await this.meter?.refresh();
          return done(...(await this.settle('re-checked', id)));
        }
        default:
          return done(false, `unknown credential action: ${String(id)}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A failed refresh/login leaves the standing state alone: the alert the
      // operator acted on is still true. The outcome is what the panel shows.
      return done(false, `${id} failed: ${trim(reason)}`);
    }
  }

  /**
   * After an action: probe when the source can, and move the state on the
   * verdict. A probe that cannot judge (429, network) leaves auth alarms
   * standing but reports the action as done; the next real call decides.
   * Without a probe, only an action that changed the credential (refresh,
   * login, set-token) clears an auth state — a bare re-check has nothing to
   * go on and must not dismiss a pending login.
   */
  private async settle(what: string, id: CredentialActionId): Promise<[boolean, string]> {
    this.armExpiryTimer();
    const persistWarning = this.source.persistWarning?.();
    const warn = persistWarning ? `; WARNING: ${persistWarning}` : '';
    if (!this.source.probe) {
      if (id === 'recheck') {
        return [true, `${what}; nothing to verify for ${this.source.provider} (no probe) — state unchanged`];
      }
      if (this.state.kind.startsWith('auth-')) this.settleAfterAuth();
      return [true, `${what}; not verified (no probe for ${this.source.provider}) — the next call will tell${warn}`];
    }
    try {
      await this.source.probe();
      if (this.state.kind.startsWith('auth-')) this.settleAfterAuth();
      // quota-unreadable lifts only on the meter's own good read (a gateway
      // can answer the probe 200 with a body the meter cannot parse); the
      // awaited recheck refresh has already updated the verdict by now.
      return [true, `${what}; credential verified${warn}`];
    } catch (err) {
      if (isAuthFailure(err)) {
        const reason = err instanceof Error ? err.message : String(err);
        this.transition({
          kind: 'auth-rejected',
          message: `${this.source.provider} still rejects the credential after ${what} (${trim(reason)})`,
          rotatable: this.source.canRefresh(),
          actions: this.authActions(),
        });
        return [false, `${what}, but the provider still rejects the credential`];
      }
      const reason = err instanceof Error ? err.message : String(err);
      return [true, `${what}; verification inconclusive (${trim(reason)})${warn}`];
    }
  }

  // ---------------------------------------------------------------------------
  // State plumbing
  // ---------------------------------------------------------------------------

  private okState(): CredentialState {
    const expiresAt = this.expiry();
    return {
      kind: 'ok',
      provider: this.source.provider,
      message: 'credential ok',
      since: this.now(),
      rotatable: this.source.canRefresh(),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      actions: [],
    };
  }

  private authActions(): CredentialAction[] {
    const actions: CredentialAction[] = [];
    if (this.source.canRefresh() && this.source.refresh) {
      actions.push({ id: 'refresh', label: 'Refresh token', hint: 'Rotates the credential with its refresh token.' });
    }
    if (this.source.login) actions.push({ id: 'login', label: 'Log in again' });
    if (this.source.setToken) {
      actions.push({ id: 'set-token', label: 'Paste new token', hint: 'Replaces the credential in memory for this process.' });
    }
    actions.push({ id: 'recheck', label: 'Re-check' });
    return actions;
  }

  private expiry(): number | undefined {
    try {
      return this.source.expiresAt?.();
    } catch {
      return undefined;
    }
  }

  private transition(next: PendingState): void {
    const prev = this.state;
    const state: CredentialState = {
      ...next,
      provider: next.provider ?? this.source.provider,
      since: next.kind === prev.kind ? prev.since : (next.since ?? this.now()),
      ...(prev.lastAction ? { lastAction: prev.lastAction } : {}),
    };
    const same = prev.kind === state.kind && prev.message === state.message;
    this.state = state;
    if (same) return;
    const data = this.alertData(state);
    if (prev.kind !== 'ok' && prev.kind !== state.kind) {
      this.emit(`${prev.kind}-clear`, state.kind === 'ok' ? `${this.source.provider} credential ok` : `superseded by ${state.kind}`, data);
    }
    if (state.kind !== 'ok') this.emit(state.kind, state.message, data);
  }

  private emit(kind: string, message: string, data: Record<string, unknown>): void {
    try {
      this.alert(kind, message, data);
    } catch (err) {
      console.error(`[credential-monitor] alert sink threw for ${kind}:`, err instanceof Error ? err.message : err);
    }
  }

  /** Alert payload: the state minus anything an operator UI cannot use. */
  private alertData(state: CredentialState): Record<string, unknown> {
    const { message: _m, lastAction: _l, ...rest } = state;
    return { ...rest };
  }
}

type PendingState = Omit<CredentialState, 'provider' | 'since'> & { provider?: string; since?: number };

function trim(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
