/**
 * Delegated access — the host's half of MCPL RFC-015.
 *
 * A server the operator granted `access.token` may ask this host, over its
 * MCPL connection, for a short-lived credential acting as the agent toward a
 * third service (`access/token {audience, endpoint?, purpose?, fresh?,
 * schemes?, timeoutMs?}`). agent-framework owns the protocol: it checks the
 * grant, validates the parameters, bounds the wait, maps a refusal to
 * `-32040`, and advertises `access` to a server only when the host wired an
 * `accessToken` provider for it. This file owns the rest:
 *
 * - **Wiring** (wireAccessTokens): a provider for a server only when its
 *   configured grant names `access.token` itself, never through a wildcard
 *   or a parent, with nothing in its deny-list covering it, and only when
 *   the agent holds an identity to mint from. A server with no provider is
 *   never advertised `access`, so it never asks.
 * - **Minting** (DelegatedAccess): from the identity module, for the
 *   audience asked, with a 15-minute lifetime asked of the home node, and
 *   the `exp` it reports given back as `expiresAt`. A reply with no usable
 *   expiry is refused, never answered.
 * - **Caching**: per configured server, principal, audience and scheme,
 *   never answered with under two minutes left; `fresh` mints anew.
 * - **Audit**: one JSON line per request in the data dir, the credential
 *   never among its fields, the endpoint cut to scheme, host, port and path.
 *
 * The agent never sees any of it (RFC-015 §8.3): nothing here reaches a tool
 * result or a trace, and no log line or audit line holds a credential.
 */
import { appendFileSync } from 'node:fs';
import { IdentityError, type IdentityFailure, type MintedAccess } from './modules/identity-module.js';
import {
  AccessRefusedError,
  isAccessRefusal,
  type AccessRefusedKind,
  type AccessTokenProvider,
  type AccessTokenRequest,
  type AccessTokenResult,
} from './af-access-shim.js';

/** The capability path a server must be granted by name (RFC-015 §4.1). */
export const ACCESS_TOKEN_PATH = 'access.token';

/** The only scheme this host offers (RFC-015 §3.2). */
export const BEARER = 'bearer';

/** The lifetime asked of the home node (RFC-015 §5: SHOULD expire within 15
 *  minutes), in archipelago-home's duration form. It can only shorten the
 *  principal's own lifetime; the `exp` the home node reports is what's given
 *  back, whatever it is. */
export const DELEGATED_TTL = '15m';

/** A cached credential is never given out with less than this left (RFC-015
 *  §5), so a server renewing before expiry always gets a new one. */
export const CACHE_MARGIN_MS = 2 * 60_000;

/** A host answers within 20 s in any case (RFC-015 §3.4). */
export const ANSWER_CEILING_MS = 20_000;

/**
 * How much sooner than agent-framework's own wait the host answers. The
 * `timeoutMs` agent-framework hands the callback is how long it waits for
 * the answer, already min(the request's timeoutMs − 2000, 20000) ms (RFC-015
 * §3.4), after which it refuses `unavailable` itself; answering a little
 * inside it means the server gets the host's reason, and the audit records
 * what the server was told rather than a credential it never received.
 */
export const ANSWER_MARGIN_MS = 250;

/** The audit file's name in the data dir. */
export const ACCESS_AUDIT_FILE = 'access-audit.jsonl';

/** What DelegatedAccess needs of the identity module. */
export interface DelegatingIdentity {
  isEnrolled(): boolean;
  sub(): string | null;
  mint(audience: string, opts: { ttl?: string; timeoutMs?: number }): Promise<MintedAccess>;
  readonly home: string;
}

/** A refusal as this file tracks it: its kind and reason are read from here,
 *  never from agent-framework's error, whose fields are its own. */
class Refusal extends Error {
  constructor(readonly kind: AccessRefusedKind | string, readonly reason: string) {
    super(reason);
  }
}

/** A credential held for reuse. */
interface Held {
  credential: string;
  expiresAtMs: number;
  principal: string | null;
}

/** One line of the audit (RFC-015 §8.2). Never a credential. */
export interface AccessAuditRecord {
  time: string;
  server: string;
  audience: string;
  /** Scheme, host with its port, and path only (auditEndpoint). */
  endpoint?: string | null;
  purpose?: string;
  fresh: boolean;
  outcome: 'issued' | 'refused';
  /** Issued from the cache rather than newly minted. */
  cached?: boolean;
  scheme?: string;
  expiresAt?: string;
  principal?: string;
  kind?: string;
  reason?: string;
}

const IDENTITY_KINDS: Record<IdentityFailure, AccessRefusedKind> = {
  not_registered: 'no_identity',
  unloaded: 'no_identity',
  refused: 'provider_refused',
  rate_limited: 'rate_limited',
  unavailable: 'unavailable',
  no_audience: 'host_policy',
};

/** RFC 3339 in UTC with a `Z`, to the second. */
export function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The endpoint as the audit records it (RFC-015 §8.2): scheme, host with a
 * port other than the scheme's default, and path, without userinfo, query or
 * fragment, where some deployments carry credentials. Null for one that isn't
 * an absolute URI, which is recorded as unreadable rather than as given.
 */
export function auditEndpoint(endpoint: string | undefined): string | null | undefined {
  if (endpoint === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  // `host` keeps a port other than the scheme's default; a URL with an
  // authority (`//`) keeps it even where the host is empty (file:///x).
  const authority = url.href.startsWith(`${url.protocol}//`) ? `//${url.host}` : '';
  return `${url.protocol}${authority}${url.pathname}`;
}

/** Characters a log reader may show as something else or as a line break,
 *  as code point ranges: DEL and the C1 controls, the soft hyphen, the Arabic
 *  letter mark, zero-width and directional marks, the line and paragraph
 *  separators and the embedding and override controls, the word joiner and
 *  invisible operators and isolates, the byte order mark, and the
 *  interlinear annotation controls. JSON.stringify escapes C0 controls,
 *  quotes and backslashes itself, and leaves these as they are. */
const UNSAFE_IN_LOG: ReadonlyArray<readonly [number, number]> = [
  [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
];

const unsafeInLog = (code: number): boolean => UNSAFE_IN_LOG.some(([low, high]) => code >= low && code <= high);

/** One audit line: JSON, with every character a log reader could misread
 *  escaped as `\uXXXX`, so free text (audience, purpose, reason) reaches the
 *  record as data and never forges or hides a line. Every such character is
 *  in a JSON string, where the escape reads back as the character. */
export function auditLine(record: AccessAuditRecord): string {
  let line = '';
  for (const char of JSON.stringify(record)) {
    const code = char.codePointAt(0)!;
    line += unsafeInLog(code) ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }
  return line;
}

/** At most `max` code points of `text`. */
function capped(text: string, max: number): string {
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max).join('')}…` : text;
}

/** Race `promise` against a deadline, rejecting with `onTimeout()` when it passes. */
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(onTimeout()), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (err) => { clearTimeout(timer); rejectPromise(err); },
    );
  });
}

export interface DelegatedAccessOptions {
  identity: DelegatingIdentity;
  /** Where the audit is appended; null keeps none. */
  auditPath: string | null;
  /** Injectable for tests. */
  now?: () => number;
  /** Operator log; console.error by default. */
  log?: (line: string) => void;
}

/**
 * Answers `access/token` for the servers wired to it, as the agent's one
 * principal. One instance per framework: its cache is per configured server,
 * so it survives a server's reconnects (RFC-015 §5).
 */
export class DelegatedAccess {
  private readonly cache = new Map<string, Held>();
  private readonly inflight = new Map<string, Promise<Held>>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: DelegatedAccessOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
  }

  /** agent-framework's `accessToken` for a server: one function serves every
   *  server wired to this instance, keyed by the `serverId` it's handed. */
  readonly provide: AccessTokenProvider = async (req) => {
    const started = this.now();
    const base: AccessAuditRecord = {
      time: new Date(started).toISOString(),
      server: req.serverId,
      audience: capped(String(req.audience), 128),
      ...(req.endpoint !== undefined ? { endpoint: auditEndpoint(capped(String(req.endpoint), 2048)) } : {}),
      ...(req.purpose !== undefined ? { purpose: capped(String(req.purpose), 256) } : {}),
      fresh: req.fresh === true,
      outcome: 'issued',
    };
    try {
      const { result, cached } = await this.answer(req, started);
      this.audit({
        ...base,
        outcome: 'issued',
        cached,
        scheme: result.scheme,
        expiresAt: result.expiresAt,
        ...(result.principal ? { principal: result.principal } : {}),
      });
      return result;
    } catch (err) {
      const refusal = this.refusalOf(err);
      this.audit({ ...base, outcome: 'refused', kind: refusal.kind, reason: capped(refusal.reason, 512) });
      this.log(
        `[access] refused server ${JSON.stringify(req.serverId)} a credential for ${JSON.stringify(base.audience)} ` +
          `(${refusal.kind}): ${JSON.stringify(refusal.reason)}`,
      );
      throw new AccessRefusedError(refusal.kind, refusal.reason);
    }
  };

  /** The answer to one request, from the cache or newly minted. */
  private async answer(req: AccessTokenRequest, started: number): Promise<{ result: AccessTokenResult; cached: boolean }> {
    const schemes = Array.isArray(req.schemes) ? req.schemes : [BEARER];
    if (!schemes.includes(BEARER)) {
      throw new Refusal(
        'host_policy',
        `this host offers only the "${BEARER}" scheme, and the request named ${schemes.map((s) => JSON.stringify(s)).join(', ') || 'none'}`,
      );
    }
    const identity = this.opts.identity;
    let principal: string | null;
    try {
      if (!identity.isEnrolled()) {
        throw new Refusal('no_identity', `the host has no registration with the identity service at ${identity.home}`);
      }
      principal = identity.sub();
    } catch (err) {
      throw this.refusalOf(err);
    }
    // One principal per host, but keyed by it all the same, so a
    // registration that changes never answers with the old one's credential.
    const key = JSON.stringify([req.serverId, principal ?? '', req.audience, BEARER]);
    if (req.fresh !== true) {
      const held = this.cache.get(key);
      if (held && held.expiresAtMs - this.now() >= CACHE_MARGIN_MS) return { result: this.resultOf(held), cached: true };
    }
    const waits = typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs) ? req.timeoutMs : ANSWER_CEILING_MS;
    const bound = Math.min(waits, ANSWER_CEILING_MS) - ANSWER_MARGIN_MS - (this.now() - started);
    if (bound <= 0) {
      throw new Refusal('unavailable', `the request left this host no time to ask the identity service at ${identity.home}`);
    }
    // Requests for one key that arrive while it's being minted share the
    // mint; `fresh` always mints its own, since the endpoint refused the last.
    let minting = req.fresh === true ? undefined : this.inflight.get(key);
    if (!minting) {
      const mint = this.mint(key, req.audience, principal, bound);
      if (req.fresh !== true) {
        minting = mint.finally(() => {
          if (this.inflight.get(key) === minting) this.inflight.delete(key);
        });
        this.inflight.set(key, minting);
      } else {
        minting = mint;
      }
    }
    const held = await withDeadline(
      minting,
      bound,
      () => new Refusal('unavailable', `the identity service at ${identity.home} didn't answer within ${bound} ms`),
    );
    return { result: this.resultOf(held), cached: false };
  }

  /** Mint a credential and keep it under `key`, unless one that lasts longer is kept already. */
  private async mint(key: string, audience: string, principal: string | null, bound: number): Promise<Held> {
    const identity = this.opts.identity;
    let minted: MintedAccess;
    try {
      minted = await identity.mint(audience, { ttl: DELEGATED_TTL, timeoutMs: bound });
    } catch (err) {
      throw this.refusalOf(err);
    }
    // archipelago-home's `exp` is seconds since the epoch. Anything else, or
    // nothing, is no expiry this host can state, so it gives no credential.
    const exp = minted.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) {
      throw new Refusal(
        'unavailable',
        `the identity service at ${identity.home} gave no expiry with the credential, so this host returns none`,
      );
    }
    const expiresAtMs = Math.floor(exp) * 1000;
    if (expiresAtMs <= this.now()) {
      throw new Refusal('unavailable', `the identity service at ${identity.home} gave a credential that had already expired`);
    }
    const held: Held = { credential: minted.token, expiresAtMs, principal: minted.sub ?? principal };
    const kept = this.cache.get(key);
    if (!kept || kept.expiresAtMs <= expiresAtMs) this.cache.set(key, held);
    this.prune();
    return held;
  }

  /** Drop credentials past their expiry. */
  private prune(): void {
    const now = this.now();
    for (const [key, held] of this.cache) if (held.expiresAtMs <= now) this.cache.delete(key);
  }

  private resultOf(held: Held): AccessTokenResult {
    return {
      scheme: BEARER,
      credential: held.credential,
      expiresAt: rfc3339(held.expiresAtMs),
      ...(held.principal ? { principal: held.principal } : {}),
    };
  }

  /** Any failure as a refusal with a kind (RFC-015 §3.3). An error this file
   *  doesn't know is `unavailable`, named by its class, never its words,
   *  which could carry a host path. */
  private refusalOf(err: unknown): Refusal {
    if (err instanceof Refusal) return err;
    if (err instanceof IdentityError) {
      const kind = err.failure ? IDENTITY_KINDS[err.failure] : 'unavailable';
      return new Refusal(kind, err.clause ?? 'the host\'s identity couldn\'t mint a credential');
    }
    if (isAccessRefusal(err)) {
      return new Refusal(
        typeof err.kind === 'string' && err.kind ? err.kind : 'unavailable',
        typeof err.reason === 'string' ? err.reason : err.message,
      );
    }
    const name = err instanceof Error ? err.name : typeof err;
    return new Refusal('unavailable', `the host couldn't mint a credential (${name})`);
  }

  private audit(record: AccessAuditRecord): void {
    const path = this.opts.auditPath;
    if (!path) return;
    try {
      appendFileSync(path, `${auditLine(record)}\n`, { mode: 0o600 });
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      this.log(`[access] couldn't append to the access audit at ${path} (${typeof code === 'string' ? code : String(err)})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Whether `pattern` covers `path` as agent-framework's capability mask reads
 * patterns: dot-separated, `*` standing for one segment, and a pattern that
 * matches a parent covering everything beneath it. The widest reading, used
 * here to find every pattern that would reach `access.token` without naming it.
 */
export function patternCovers(pattern: string, path: string): boolean {
  const p = pattern.split('.');
  const segments = path.split('.');
  if (p.length > segments.length) return false;
  return p.every((part, i) => part === '*' || part === segments[i]);
}

/** The text items of a configured capability list. */
function patternsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Whether a server's configured grant gives it `access.token`, and what an
 * operator should hear about it. Strict, as RFC-015 §4.1 asks: only the exact
 * path in `enabledCapabilities` grants it, never a wildcard (`access.*`,
 * `*.token`, `*.*`) or a parent (`access`); and any `disabledCapabilities`
 * pattern covering it denies it, the deny-list winning as it does in
 * agent-framework's mask.
 */
export function accessTokenGrant(server: Record<string, unknown>): { granted: boolean; warnings: string[] } {
  const enabled = patternsOf(server.enabledCapabilities);
  const named = enabled.includes(ACCESS_TOKEN_PATH);
  const warnings: string[] = [];
  const near = enabled.filter((p) => p !== ACCESS_TOKEN_PATH && patternCovers(p, ACCESS_TOKEN_PATH));
  if (!named && near.length > 0) {
    warnings.push(
      `enabledCapabilities ${near.map((p) => JSON.stringify(p)).join(', ')} would cover "${ACCESS_TOKEN_PATH}", but no ` +
        `wildcard or parent grants it (MCPL RFC-015 §4.1). To let this server act as the agent, name "${ACCESS_TOKEN_PATH}" itself`,
    );
  }
  if (!named) return { granted: false, warnings };
  const denied = patternsOf(server.disabledCapabilities).filter((p) => patternCovers(p, ACCESS_TOKEN_PATH));
  if (denied.length > 0) {
    warnings.push(
      `enabledCapabilities names "${ACCESS_TOKEN_PATH}", but disabledCapabilities ` +
        `${denied.map((p) => JSON.stringify(p)).join(', ')} denies it, and the deny-list wins`,
    );
    return { granted: false, warnings };
  }
  return { granted: true, warnings };
}

/**
 * The DelegatedAccess for a framework, or why there is none: no identity
 * module, or an identity that holds no registration to mint from (RFC-015
 * §4.2: such a host advertises nothing). Registration is read once, here, at
 * load: a host registered later wires delegated access at its next start.
 */
export function delegatedAccessFor(
  identity: DelegatingIdentity | null,
  options: Omit<DelegatedAccessOptions, 'identity'>,
): { access: DelegatedAccess; whyNot?: undefined } | { access: null; whyNot: string } {
  if (!identity) return { access: null, whyNot: 'the recipe has no identity module (modules.identity)' };
  let enrolled: boolean;
  try {
    enrolled = identity.isEnrolled();
  } catch (err) {
    return { access: null, whyNot: `whether this host is registered is unknown (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!enrolled) {
    return {
      access: null,
      whyNot: `this host has no registration with the identity service at ${identity.home} (the agent registers with ` +
        'identity--accept_invite; restart the host after it does)',
    };
  }
  return { access: new DelegatedAccess({ identity, ...options }) };
}

/**
 * Attach `accessToken` to each server whose configured grant names
 * `access.token` (accessTokenGrant), when there is delegated access to give;
 * every other server gets none, so agent-framework advertises `access` to
 * none of them. Any `accessToken` a config file carried is dropped first:
 * only the host attaches one. Returns the operator's lines.
 */
export function wireAccessTokens(
  servers: Array<{ id: string } & Record<string, unknown>>,
  wiring: { access: DelegatedAccess | null; whyNot?: string },
): string[] {
  const lines: string[] = [];
  for (const server of servers) {
    delete server.accessToken;
    const { granted, warnings } = accessTokenGrant(server);
    for (const warning of warnings) lines.push(`[mcpl] server "${server.id}": ${warning}`);
    if (!granted) continue;
    if (wiring.access) {
      server.accessToken = wiring.access.provide;
    } else {
      lines.push(
        `[mcpl] server "${server.id}": granted "${ACCESS_TOKEN_PATH}", but ${wiring.whyNot ?? 'there is no identity to mint from'}, ` +
          'so it isn\'t wired: the host doesn\'t advertise access to it, and it gets no credential',
      );
    }
  }
  return lines;
}
