/**
 * Observer identity for the webui — the M2 layer of connectome
 * docs/observability.md.
 *
 * An observer is an Archipelago layer-0 principal: an ed25519 keypair,
 * human device or agent or service. Authorization is a per-agent grant file
 * (data/observers.json) that is hot-reloaded on mtime (the proven
 * discord-filters pattern: atomic tmp+rename writes, parse errors keep the
 * previous state) and editable by the agent itself through the observers
 * module's tools — interiority access is a consent question, so the agent
 * holds the pen.
 *
 * The handshake is challenge-less: the client signs a statement binding the
 * Host it connected to + a fresh timestamp (replay/relay-proof, no extra
 * round trip):
 *
 *   sign( "connectome-observer|v1|<host>|<timestamp>" )
 *
 * The server verifies signature, freshness (±5 min), and that the key has a
 * live grant — then the connection carries that grant's scope mask.
 */
import { readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPublicKey, verify as cryptoVerify, randomBytes } from 'node:crypto';

/** Scope = event-family mask. See docs/observability.md §4. */
export const OBSERVER_SCOPES = ['health', 'ops', 'messages', 'tools', 'thinking', 'debug'] as const;
export type ObserverScope = typeof OBSERVER_SCOPES[number];

export interface ObserverGrant {
  /** `ed25519:<base64url of the raw 32-byte public key>` */
  key: string;
  /** Human-readable label. Testimony, not identity — never treat as verified naming. */
  label: string;
  scopes: ObserverScope[];
  /** ISO expiry; null/absent = no expiry. */
  expires?: string | null;
  /** Protected grants cannot be revoked via the agent-facing tools
   *  (recipe-designated operator baseline). File edits can still remove them. */
  protected?: boolean;
}

export interface ObserversFile {
  observers: ObserverGrant[];
}

/** The identity envelope a client presents in its observer-hello frame. */
export interface ObserverHelloIdentity {
  scheme: 'ed25519';
  /** `ed25519:<base64url raw pubkey>` — must match a grant. */
  id: string;
  /** base64url ed25519 signature over the bound statement. */
  proof: string;
  /** ISO timestamp the statement was signed at (freshness-checked). */
  timestamp: string;
  displayName?: string;
}

const FRESHNESS_MS = 5 * 60_000;

export function observerStatement(host: string, timestamp: string): string {
  return `connectome-observer|v1|${host}|${timestamp}`;
}

function b64urlToBuf(s: string): Buffer | null {
  try {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
}

/** Raw 32-byte ed25519 public key → node KeyObject (SPKI DER wrap). */
export function ed25519PublicKey(raw: Buffer) {
  const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

// ---------------------------------------------------------------------------
// File ops — the discord-mcpl filters.ts pattern, verbatim mechanics.
// ---------------------------------------------------------------------------

export function loadObserversFile(path: string): ObserversFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ObserversFile;
    if (!parsed || !Array.isArray(parsed.observers)) return null;
    for (const g of parsed.observers) {
      if (typeof g.key !== 'string' || !g.key.startsWith('ed25519:')) return null;
      if (!Array.isArray(g.scopes)) return null;
      if (!g.scopes.every((s) => (OBSERVER_SCOPES as readonly string[]).includes(s))) return null;
    }
    return parsed;
  } catch {
    return null; // parse/validation error → caller keeps previous (fail-safe)
  }
}

export function saveObserversFile(path: string, file: ObserversFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
  renameSync(tmp, path); // atomic — mtime pollers never read a half-write
}

export function observersFileMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface VerifyResult {
  grant: ObserverGrant;
  scopes: Set<ObserverScope>;
}

export class ObserverRegistry {
  private file: ObserversFile | null = null;
  private lastMtime: number | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly path: string) {}

  start(): void {
    this.lastMtime = observersFileMtime(this.path);
    if (this.lastMtime !== null) {
      this.file = loadObserversFile(this.path);
      if (!this.file) console.error(`[webui-observers] ${this.path} unparseable — observers disabled until fixed`);
    }
    this.poll = setInterval(() => {
      const m = observersFileMtime(this.path);
      if (m === null || m === this.lastMtime) return; // missing/mid-rename or unchanged
      this.lastMtime = m;
      const next = loadObserversFile(this.path);
      if (!next) {
        console.error(`[webui-observers] ${this.path} unparseable — keeping previous grants`);
        return;
      }
      this.file = next;
      console.error(`[webui-observers] reloaded ${next.observers.length} grant(s)`);
    }, 3000);
    this.poll.unref();
  }

  stop(): void {
    if (this.poll) clearInterval(this.poll);
  }

  /** True when at least one live grant exists — gates the whole feature:
   *  no grants ⇒ webui behaves exactly as before this layer existed. */
  active(): boolean {
    return (this.file?.observers.length ?? 0) > 0;
  }

  grants(): ObserverGrant[] {
    return this.file?.observers ?? [];
  }

  /**
   * Verify an observer-hello identity envelope against the live grants.
   * Returns the grant + scope set, or null (with a stderr reason — auth
   * failures on a headless box must be diagnosable).
   */
  verifyHello(identity: ObserverHelloIdentity, hostHeader: string, now = Date.now()): VerifyResult | null {
    const fail = (why: string): null => {
      console.error(`[webui-observers] hello rejected (${identity?.id ?? 'no-id'}): ${why}`);
      return null;
    };
    if (!identity || identity.scheme !== 'ed25519') return fail('unsupported scheme');
    if (typeof identity.id !== 'string' || !identity.id.startsWith('ed25519:')) return fail('bad key id');

    const ts = Date.parse(identity.timestamp ?? '');
    if (!Number.isFinite(ts)) return fail('bad timestamp');
    if (Math.abs(now - ts) > FRESHNESS_MS) return fail('stale timestamp');

    const grant = this.grants().find((g) => g.key === identity.id);
    if (!grant) return fail('no grant for key');
    if (grant.expires && Date.parse(grant.expires) < now) return fail('grant expired');

    const raw = b64urlToBuf(identity.id.slice('ed25519:'.length));
    if (!raw || raw.length !== 32) return fail('malformed public key');
    const sig = b64urlToBuf(identity.proof ?? '');
    if (!sig || sig.length !== 64) return fail('malformed signature');

    try {
      const okSig = cryptoVerify(
        null,
        Buffer.from(observerStatement(hostHeader, identity.timestamp), 'utf8'),
        ed25519PublicKey(raw),
        sig,
      );
      if (!okSig) return fail('signature verify failed');
    } catch (err) {
      return fail(`verify error: ${err instanceof Error ? err.message : err}`);
    }
    return { grant, scopes: new Set(grant.scopes) };
  }
}

// ---------------------------------------------------------------------------
// Sessions — short-lived bearer tokens minted after WS auth so the SPA can
// hit /debug/* and /healthz over plain HTTP. The WS is the authentication
// event; HTTP rides it.
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 12 * 60 * 60_000;

export interface ObserverSession {
  scopes: Set<ObserverScope>;
  /**
   * Full sessions carry OPERATOR authority (equivalent to basic auth): the
   * WS upgrade treats the connection as a full client, not a read-only
   * observer. Minted only by /auth/basic after a successful password
   * challenge. Exists because browsers reliably attach cookies to WebSocket
   * upgrades but (Chrome, notably) do NOT attach cached basic-auth
   * credentials — without this, password sign-in loops back to the gate.
   */
  full: boolean;
}

export class ObserverSessions {
  private sessions = new Map<string, ObserverSession & { expiresAt: number }>();

  mint(scopes: Set<ObserverScope>, opts?: { full?: boolean }): string {
    // Opportunistic sweep — the map stays tiny (one entry per auth event).
    const now = Date.now();
    for (const [t, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(t);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { scopes, full: opts?.full ?? false, expiresAt: now + SESSION_TTL_MS });
    return token;
  }

  lookup(token: string | null | undefined): ObserverSession | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s || s.expiresAt < Date.now()) return null;
    return { scopes: s.scopes, full: s.full };
  }
}

/** Extract the observer session token from a request (cookie `fkm_obs`). */
export function sessionTokenFromRequest(req: Request): string | null {
  const cookie = req.headers.get('cookie');
  if (!cookie) return null;
  const m = /(?:^|;\s*)fkm_obs=([a-f0-9]{64})/.exec(cookie);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// Scope filtering — pure projections of wire data through a grant's mask
// (docs/observability.md §4). Kept here (not in the module) so they are
// unit-testable without the webui's process-level server singleton.
// ---------------------------------------------------------------------------

import type { WelcomeMessage, WelcomeMessageEntry } from '../web/protocol.js';

/** Which scope a trace event requires. Token deltas map by blockType;
 *  ops/mcpl lifecycle → 'ops'; usage → 'health'; the rest is conversation
 *  lifecycle → 'messages'. */
export function traceRequiredScope(event: { type: string }): ObserverScope {
  const t = event.type;
  if (t.startsWith('ops:') || t.startsWith('mcpl:')) return 'ops';
  if (t === 'usage:updated') return 'health';
  if (t === 'inference:tokens' || t === 'inference:content_block') {
    const bt = (event as { blockType?: string }).blockType;
    if (bt === 'thinking') return 'thinking';
    if (bt === 'tool_call' || bt === 'tool_result') return 'tools';
    return 'messages';
  }
  if (t.startsWith('tool:')) return 'tools';
  return 'messages';
}

/** Project a wire entry through a scope mask: null when the observer may not
 *  see messages at all; otherwise thinking/tool blocks are elided per scope.
 *  Filtering, not rewriting — the wire is already typed blocks. */
export function filterEntryForScopes(
  entry: WelcomeMessageEntry,
  scopes: Set<ObserverScope>,
): WelcomeMessageEntry | null {
  if (!scopes.has('messages')) return null;
  if (scopes.has('thinking') && scopes.has('tools')) return entry;
  const blocks = entry.blocks.filter((b) => {
    if ((b.kind === 'thinking' || b.kind === 'redacted_thinking') && !scopes.has('thinking')) return false;
    if ((b.kind === 'tool_use' || b.kind === 'tool_result') && !scopes.has('tools')) return false;
    return true;
  });
  return { ...entry, blocks };
}

/** Project a welcome through an observer's scope mask. Without 'messages'
 *  the entire conversation payload (entries + agent trees, which carry
 *  streaming buffers) is emptied — a health/ops observer like the fleet hub
 *  gets structure and usage, never content. Without 'health' the telemetry
 *  fields (usage / perAgentCost / callLedger) are masked too: their live
 *  frames (`usage`, `call-ledger`) are gated on 'health', and the welcome
 *  must refuse exactly what the stream refuses — otherwise a messages-only
 *  observer reads model IDs, per-call costs, and raw provider errors on
 *  connect that it is denied a second later. */
export function scopeWelcome(welcome: WelcomeMessage, scopes: Set<ObserverScope>): WelcomeMessage {
  const emptyTree = { asOfTs: Date.now(), nodes: [], callIdIndex: {} };
  const scoped: WelcomeMessage = { ...welcome };
  if (!scopes.has('health')) {
    delete scoped.callLedger;
    delete scoped.perAgentCost;
    // `usage` is required by the wire type, so it is zeroed rather than
    // dropped (matches the emptied-not-deleted style of the fields below).
    scoped.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  if (!scopes.has('messages')) {
    return {
      ...scoped,
      messages: [],
      history: { startIndex: welcome.history.totalCount, totalCount: welcome.history.totalCount },
      localTree: emptyTree,
      childTrees: [],
    };
  }
  return {
    ...scoped,
    messages: welcome.messages
      .map((e) => filterEntryForScopes(e, scopes))
      .filter((e): e is WelcomeMessageEntry => e !== null),
    // Agent trees replay tool calls + streaming thinking; only full
    // interiority scopes get them.
    ...(scopes.has('thinking') && scopes.has('tools')
      ? {}
      : { localTree: emptyTree, childTrees: [] }),
  };
}
