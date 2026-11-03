import { readFileSync, renameSync, statSync, lstatSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPublicKey, verify as cryptoVerify, randomBytes } from 'node:crypto';
import { parseHandWrittenJson } from '../hand-written-json.js';

/** Scope = event-family mask. */
export const OBSERVER_SCOPES = ['health', 'ops', 'messages', 'tools', 'thinking', 'debug'] as const;
export type ObserverScope = typeof OBSERVER_SCOPES[number];

export interface ObserverGrant {
  /** `ed25519:<base64url of the raw 32-byte public key>`. The file may spell
   *  the same key in either base64 alphabet, padded or not. */
  key: string;
  /** Human-readable label. Testimony, not identity — never treat as verified naming. */
  label: string;
  scopes: ObserverScope[];
  /** Expiry: as the tools write it, a date in ECMAScript's own form, alone
   *  or with a time and a zone (Z or an offset), or null. The file may hold
   *  any value Date.parse reads; absent, null, empty or any other falsy value
   *  means no expiry. */
  expires?: string | null;
  /** Protected grants cannot be revoked via the agent-facing tools, nor
   *  made by them. File edits can still remove them. */
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

/**
 * The statement an observer signs with its ed25519 key:
 * `connectome-observer|v1|<host>|<timestamp>`, binding the Host it connected
 * to and a fresh timestamp. The server checks the signature, freshness
 * (±5 min) and that the key has a live grant; the connection then carries
 * that grant's scopes.
 */
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

export function canonicalKey(key: unknown): string | null {
  if (typeof key !== 'string' || !key.startsWith('ed25519:')) return null;
  const body = key.slice('ed25519:'.length);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(body)) return null;
  const raw = b64urlToBuf(body);
  return raw && raw.length === 32 ? `ed25519:${raw.toString('base64url')}` : null;
}

export function ed25519PublicKey(raw: Buffer) {
  const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export type ObserversFileRead =
  | { kind: 'ok'; file: ObserversFile; problems: string[]; doc: GrantsDocument }
  | { kind: 'missing' }
  | { kind: 'unparsed'; problem: string }
  | { kind: 'unreadable'; problem: string; readFailed?: true; code?: string };

export type GrantsDocument = Record<string, unknown> & { observers: unknown[] };

export function readObserversFile(path: string): ObserversFileRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      // A link whose target is gone reads as ENOENT too.
      return isLink(path)
        ? { kind: 'unreadable', problem: `is a link to a file that can't be read (${errorText(err)})`, readFailed: true }
        : { kind: 'missing' };
    }
    return { kind: 'unreadable', problem: `can't be read (${errorText(err)})`, readFailed: true, ...(typeof code === 'string' ? { code } : {}) };
  }
  let parsed: unknown;
  try {
    parsed = parseHandWrittenJson(text);
  } catch (err) {
    return err instanceof SyntaxError
      ? { kind: 'unparsed', problem: `isn't valid JSON (${errorText(err)})` }
      : { kind: 'unreadable', problem: `can't be checked (${errorText(err)})` };
  }
  return checkObserversFile(parsed);
}

export function checkObserversFile(parsed: unknown): Exclude<ObserversFileRead, { kind: 'missing' | 'unparsed' }> {
  try {
    return checkGrants(parsed);
  } catch (err) {
    // JSON.stringify overflows on a value nested deeply enough.
    return { kind: 'unreadable', problem: `can't be checked (${errorText(err)})` };
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function checkGrants(parsed: unknown): Exclude<ObserversFileRead, { kind: 'missing' | 'unparsed' }> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unreadable', problem: `isn't a grants file: it holds ${jsonKind(parsed)}, not an object with an "observers" list` };
  }
  const found = parsed as Record<string, unknown>;
  const observers = found.observers === undefined ? [] : found.observers;
  if (!Array.isArray(observers)) return { kind: 'unreadable', problem: 'has an "observers" that isn\'t a list' };
  const usable: ObserverGrant[] = [];
  const problems: string[] = [];
  const firstFor = new Map<string, number>();
  for (const [i, g] of (observers as unknown[]).entries()) {
    const wrong = entryProblems(i, g);
    const key = canonicalKey(g && typeof g === 'object' ? (g as { key?: unknown }).key : undefined);
    if (key !== null) {
      const first = firstFor.get(key);
      if (first === undefined) firstFor.set(key, i);
      else wrong.push(`${entryName(i, g)} repeats the key of grant ${first + 1}, so it isn't used`);
    }
    if (wrong.length === 0 && key !== null) usable.push({ ...(g as ObserverGrant), key });
    else problems.push(...wrong);
  }
  return { kind: 'ok', file: { observers: usable }, problems, doc: { ...found, observers } };
}

function entryProblems(i: number, g: unknown): string[] {
  if (!g || typeof g !== 'object') return [`grant ${i + 1} isn't an object`];
  const grant = g as { key?: unknown; label?: unknown; scopes?: unknown; expires?: unknown };
  const which = entryName(i, g);
  const problems: string[] = [];
  if (typeof grant.key !== 'string' || !grant.key.startsWith('ed25519:')) {
    problems.push(`${which} has no "ed25519:" key`);
  } else if (canonicalKey(grant.key) === null) {
    problems.push(`${which} has a key that doesn't decode to 32 bytes`);
  }
  const { expires } = grant;
  if (expires && !Number.isFinite(parseDate(expires))) {
    problems.push(`${which} has an expiry that isn't a date: ${shown(expires)}`);
  }
  if (!Array.isArray(grant.scopes)) {
    problems.push(`${which} has no list of scopes`);
    return problems;
  }
  if (grant.scopes.length === 0) {
    problems.push(`${which} has no scopes`);
    return problems;
  }
  const unknown = grant.scopes.filter((s) => !(OBSERVER_SCOPES as readonly unknown[]).includes(s));
  if (unknown.length > 0) {
    const what = unknown.length === 1 ? "a scope that doesn't exist" : "scopes that don't exist";
    problems.push(
      `${which} names ${what}: ${unknown.map(shown).join(', ')} (the scopes are ${OBSERVER_SCOPES.join(', ')})`,
    );
  }
  return problems;
}

/** Date.parse converts an object through its toString or valueOf, and
 *  throws when it can call neither. */
function parseDate(value: unknown): number {
  try {
    return Date.parse(value as string);
  } catch {
    return NaN;
  }
}

/** JSON.stringify shows a non-finite number as null. */
function shown(value: unknown): string {
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value);
}

function entryName(i: number, g: unknown): string {
  const label = g && typeof g === 'object' ? (g as { label?: unknown }).label : undefined;
  return `grant ${i + 1}${typeof label === 'string' ? ` (${JSON.stringify(label)})` : ''}`;
}

function jsonKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'string') return 'a string';
  return String(value);
}

export function loadObserversFile(path: string): ObserversFile | null {
  const read = readObserversFile(path);
  return read.kind === 'ok' ? read.file : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function saveObserversFile(path: string, file: ObserversFile): void {
  const target = isLink(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, keepNonFinite, 2) + '\n');
  renameSync(tmp, target); // atomic: a reader never sees half a write
}

/** JSON has no Infinity: a number too large for it, such as 1e309, parses
 *  as Infinity, and JSON.stringify writes that as null. */
function keepNonFinite(_key: string, value: unknown): unknown {
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
}

/** cp -p and rsync -t keep a file's mtime, and chmod changes only its
 *  ctime. */
export function observersFileStat(path: string): { sig: string } | { problem: string } {
  try {
    const s = statSync(path);
    return { sig: `${s.mtimeMs}:${s.ctimeMs}:${s.ino}:${s.size}` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // A link whose target is gone stats as missing too.
      return { problem: isLink(path) ? `is a link to a file that can't be read (${code})` : 'is gone' };
    }
    return { problem: `can't be read (${code ?? (err instanceof Error ? err.message : String(err))})` };
  }
}

export interface VerifyResult {
  grant: ObserverGrant;
  scopes: Set<ObserverScope>;
}

export class ObserverRegistry {
  private file: ObserversFile | null = null;
  private lastSig: string | null = null;
  private present = false;
  private misses = 0;
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastSaid: string | null = null;

  constructor(private readonly path: string, private readonly pollMs = 3000) {}

  start(onCheck?: () => void): void {
    const at = observersFileStat(this.path);
    this.present = 'sig' in at;
    if ('problem' in at && at.problem !== 'is gone') {
      this.say(`[webui-observers] ${this.path} ${at.problem} — admitting no grants from it`);
    }
    if ('sig' in at) this.load(at.sig, readObserversFile(this.path), 'start');
    this.poll = setInterval(() => {
      this.check();
      if (!onCheck) return;
      try {
        onCheck();
      } catch (err) {
        console.error(`[webui-observers] after a check: ${errorText(err)}`);
      }
    }, this.pollMs);
    this.poll.unref();
  }

  private check(): void {
    const at = observersFileStat(this.path);
    if ('problem' in at) {
      this.missed(at.problem);
      return;
    }
    if (at.sig !== this.lastSig) {
      const read = readObserversFile(this.path);
      if (read.kind === 'missing' || (read.kind === 'unreadable' && read.readFailed === true)) {
        this.missed(read.kind === 'missing' ? 'is gone' : read.problem);
        return;
      }
      this.load(at.sig, read, 'reload');
    }
    this.misses = 0;
    this.present = true;
  }

  private missed(problem: string): void {
    if (++this.misses < 2) return;
    this.lastSig = null;
    this.file = null;
    if (this.present) {
      this.present = false;
      this.say(`[webui-observers] ${this.path} ${problem} — admitting no grants from it`);
    }
  }

  private load(sig: string, read: ObserversFileRead, when: 'start' | 'reload'): void {
    const again = read.kind === 'unparsed' || read.kind === 'missing'
      || (read.kind === 'unreadable' && read.readFailed === true);
    this.lastSig = again ? null : sig;
    this.take(read, when);
  }

  private take(read: ObserversFileRead, when: 'start' | 'reload'): void {
    const where = `[webui-observers] ${this.path}`;
    const say = (line: string) => this.say(line);
    if (read.kind === 'ok') {
      this.file = read.file;
      this.lastSaid = null;
      const unused = read.doc.observers.length - read.file.observers.length;
      if (unused > 0) console.error(`${where}: ${unused} grant(s) not used: ${read.problems.join('; ')}`);
      if (when === 'reload') console.error(`[webui-observers] reloaded ${read.file.observers.length} grant(s)`);
      return;
    }
    if (read.kind === 'unparsed' && when === 'reload' && this.file) {
      say(`${where} ${read.problem} — keeping the previous grants until it parses`);
      return;
    }
    this.file = null;
    if (read.kind === 'missing') say(`${where} is gone — admitting no grants from it`);
    else if (read.kind === 'unparsed') say(`${where} ${read.problem} — admitting no grants until it parses`);
    else say(`${where} ${read.problem} — admitting no grants from it`);
  }

  private say(line: string): void {
    if (line !== this.lastSaid) console.error(line);
    this.lastSaid = line;
  }

  stop(): void {
    if (this.poll) clearInterval(this.poll);
  }

  active(): boolean {
    return (this.file?.observers.length ?? 0) > 0;
  }

  grants(): ObserverGrant[] {
    return this.file?.observers ?? [];
  }

  liveScopes(key: string, now = Date.now()): Set<ObserverScope> | null {
    const grant = this.grants().find((g) => g.key === key);
    if (!grant) return null;
    if (grant.expires && Date.parse(grant.expires) < now) return null;
    return new Set(grant.scopes);
  }

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

    const key = canonicalKey(identity.id);
    if (!key) return fail('malformed public key');
    const grant = this.grants().find((g) => g.key === key);
    if (!grant) return fail('no grant for key');
    if (grant.expires && Date.parse(grant.expires) < now) return fail('grant expired');

    const raw = b64urlToBuf(key.slice('ed25519:'.length))!;
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

const SESSION_TTL_MS = 12 * 60 * 60_000;

export interface ObserverSession {
  scopes: Set<ObserverScope>;
  full: boolean;
}

export class ObserverSessions {
  private sessions = new Map<string, ObserverSession & { expiresAt: number; key?: string }>();

  mint(scopes: Set<ObserverScope>, opts: { full: true } | { key: string }): string {
    const now = Date.now();
    for (const [t, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(t);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, {
      scopes,
      full: 'full' in opts,
      expiresAt: now + SESSION_TTL_MS,
      key: 'key' in opts ? opts.key : undefined,
    });
    return token;
  }

  lookup(token: string | null | undefined): ObserverSession | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s || s.expiresAt < Date.now()) return null;
    return { scopes: s.scopes, full: s.full };
  }

  narrowToGrants(liveScopes: (key: string) => Set<ObserverScope> | null): number {
    const now = Date.now();
    let ended = 0;
    for (const [token, s] of this.sessions) {
      if (s.key === undefined || s.expiresAt < now || narrow(s, liveScopes(s.key))) continue;
      this.sessions.delete(token);
      ended++;
    }
    return ended;
  }
}

function narrow(s: { scopes: Set<ObserverScope> }, live: Set<ObserverScope> | null): boolean {
  if (!live) return false;
  if ([...s.scopes].some((scope) => !live.has(scope))) {
    const kept = new Set([...s.scopes].filter((scope) => live.has(scope)));
    if (kept.size === 0) return false;
    s.scopes = kept;
  }
  return true;
}

export function sessionTokenFromRequest(req: Request): string | null {
  const cookie = req.headers.get('cookie');
  if (!cookie) return null;
  const m = /(?:^|;\s*)fkm_obs=([a-f0-9]{64})/.exec(cookie);
  return m ? m[1]! : null;
}

import { AGENT_TREE_SCOPES, type CallLedgerSnapshot, type StreamEndedMessage, type WebUiServerMessage, type WelcomeMessage, type WelcomeMessageEntry } from '../web/protocol.js';
import { STREAM_END_TRACES } from '../state/turn-trace.js';

export const FULL_CLIENTS_ONLY = 'full-clients-only';

export type FrameScopes = readonly ObserverScope[] | typeof FULL_CLIENTS_ONLY;

const MESSAGES: FrameScopes = ['messages'];
const TOOLS: FrameScopes = ['messages', 'tools'];
const THINKING: FrameScopes = ['messages', 'thinking'];
const HEALTH: FrameScopes = ['health'];
const OPS: FrameScopes = ['ops'];
const TOOLS_AND_OPS: FrameScopes = ['messages', 'tools', 'ops'];
const ALL_BUT_DEBUG: FrameScopes = AGENT_TREE_SCOPES;

export const TRACE_SCOPES: Readonly<Record<string, FrameScopes>> = {
  // The conversation and its turns.
  'message:added': MESSAGES,
  'message:removed': MESSAGES,
  'inference:started': MESSAGES,
  'inference:turn_ended': MESSAGES,
  // The messages injected into a turn.
  'inference:stream_resumed': MESSAGES,
  // Branch names.
  'undo:completed': MESSAGES,
  'redo:completed': MESSAGES,
  // A turn's end, and a restart for its context budget, carry token counts.
  'inference:completed': ['messages', 'health'],
  'inference:stream_restarted': ['messages', 'health'],
  // Token deltas and content blocks, by the block they're in (traceScopes);
  // this is a text block's.
  'inference:tokens': MESSAGES,
  'inference:content_block': MESSAGES,
  // Tool calls, their inputs and their results.
  'inference:tool_calls_yielded': TOOLS,
  'tool:started': TOOLS,
  'tool:completed': TOOLS,
  // A failed call's error, a dropped call's result, and a call an operator
  // made for the agent, are ops besides.
  'tool:failed': TOOLS_AND_OPS,
  'tool:result_dropped': TOOLS_AND_OPS,
  'puppet:tool-call': TOOLS_AND_OPS,
  // Whole process events and module responses: messages, thinking blocks,
  // tool results and their errors, and a module's own payload and response,
  // which are opaque and so can hold health and ops data too.
  'process:received': ALL_BUT_DEBUG,
  'process:completed': ALL_BUT_DEBUG,
  // Usage and serving state.
  'usage:updated': HEALTH,
  'inference:usage': HEALTH,
  'host:quiesce': HEALTH,
  'host:resume': HEALTH,
  'host:quiesced_boot': HEALTH,
  'inference:waiting': HEALTH,
  // Alerts: failures and refusals, the gate's decisions, modules coming and
  // going, MCPL servers and conversations, and what operators did.
  'ops:alert': OPS,
  // The operator log's entry, with what the operator acted on and set.
  'operator:action': OPS,
  'inference:failed': OPS,
  'inference:exhausted': OPS,
  // Why a turn was stopped. A client with messages and without ops gets
  // stream-ended in its place.
  'inference:aborted': ['messages', 'ops'],
  'inbound:observer-failed': OPS,
  'inference:request_dropped': OPS,
  'inference:request_stale': OPS,
  'tool:spill_failed': OPS,
  'module:batch_hook_failed': OPS,
  'module:added': OPS,
  'module:removed': OPS,
  'gate:policy-matched': OPS,
  'gate:config-error': OPS,
  'gate:debounce-delivered': OPS,
  'gate:config-reloaded': OPS,
  'gate:decision': OPS,
  'gate:held-dropped': OPS,
  // Admission and the Dendrite registry (agent-framework#546): a decision is
  // an ops fact; an agent's creation, end, interruption, orphaning and
  // reparenting are the host's health as the tree shows it, and ops; mail
  // traces carry ids and routes, never content; a reader fork's run and the
  // report it delivers are the tune-out's ops, the report a message too.
  'admission:decided': OPS,
  'dendrite:agent-created': ['health', 'ops'],
  'dendrite:agent-ended': ['health', 'ops'],
  'dendrite:agent-interrupted': ['health', 'ops'],
  'dendrite:agent-orphaned': ['health', 'ops'],
  'dendrite:agent-reparented': ['health', 'ops'],
  'dendrite:activation-cancelled': ['health', 'ops'],
  'dendrite:early-traces-dropped': OPS,
  'dendrite:mail-held': OPS,
  'dendrite:mail-deferred': OPS,
  'dendrite:mail-delivered': OPS,
  'tune-out:reader-fork': OPS,
  // A reader fork whose framing, derive or run threw before it reported; its messages go back to the channel's next reader (agent-framework #793).
  'tune-out:reader-fork-failed': OPS,
  'tune-out:reader-prose-delivered': ['messages', 'ops'],
  'gate:wake-line-omitted': OPS,
  'gate:policy-added': OPS,
  'gate:policy-removed': OPS,
  'gate:config-reconciled': OPS,
  'gate:shadow-warnings': OPS,
  'gate:judge-verdict': ['health', 'ops'],
  'mcpl:push-event-rejected': OPS,
  'mcpl:channel-incoming-rejected': OPS,
  'mcpl:empty-content-dropped': OPS,
  // Content context-manager won't store, refused where it would be written:
  // the server or module, the event and the places in it, none of the content.
  'mcpl:malformed-content-refused': OPS,
  'process:response-refused': OPS,
  'mcpl:coalescing': OPS,
  'mcpl:request-handler-error': OPS,
  'mcpl:server-stderr': OPS,
  'mcpl:server-connect-failed': OPS,
  'mcpl:server-reconnected': OPS,
  'mcpl:server-closed': OPS,
  'mcpl:server-error': OPS,
  'mcpl:policy-refused': OPS,
  'mcpl:feature-set-disabled': OPS,
  'mcpl:tool-pattern-unmatched': OPS,
  'mcpl:orphaned-response': OPS,
  'mcpl:manifest-change-receipt': OPS,
  'mcpl:conversation-spawned': OPS,
  'mcpl:conversation-spawn-failed': OPS,
  'mcpl:conversation-unrouted': OPS,
  'mcpl:conversation-binding-orphaned': OPS,
  'mcpl:conversation-closed': OPS,
  'mcpl:conversation-disposed': OPS,
  'mcpl:speech-route-failed': OPS,
  'mcpl:channels-register': OPS,
  'mcpl:channel-descriptor-rejected': OPS,
  'mcpl:channels-changed': OPS,
  'mcpl:channels-incoming': OPS,
  'mcpl:channel-lazy-registered': ['messages', 'ops'],
  'mcpl:channel-reconcile-failed': OPS,
  'mcpl:channel-open-substituted': OPS,
  'mcpl:channel-reconcile-skipped': OPS,
  'mcpl:channel-opened-by-send': OPS,
  'mcpl:channel-open-failed': OPS,
  'mcpl:state_registered': OPS,
  'mcpl:checkpoint_recorded': OPS,
  'mcpl:state_rollback': OPS,
  'mcpl:push_event': OPS,
  'mcpl:inference_start': ['health', 'ops'],
  'mcpl:inference_fail': ['health', 'ops'],
  'mcpl:inference_complete': ['health', 'ops'],
  'tune-out:entered': OPS,
  'tune-out:cancelled': OPS,
  'tune-out:timer-failed': OPS,
  'tune-out:ack-failed': OPS,
  // Held speech's delivery: held, resent, dismissed, with no text.
  'prose:drafts-held': OPS,
  'prose:draft-resent': OPS,
  'prose:drafts-dismissed': OPS,
  // The routed prose, verbatim.
  'mcpl:speech-routed': ['messages', 'ops'],
  // The prose published to an MCPL server's channel, chunk by chunk and whole
  // at its end, with the server and channel: what the agent said, and where,
  // with no outcome, so messages alone, as the model's own text is.
  'inference:published': MESSAGES,
  'inference:published_complete': MESSAGES,
};

/** agent-framework's token deltas and content blocks name their block's
 *  type. */
export function traceScopes(event: { type: string; blockType?: unknown; model?: unknown }): FrameScopes {
  if (event.type === 'mcpl:inference_fail' && event.model === null) return OPS;
  if (event.type === 'inference:tokens' || event.type === 'inference:content_block') {
    if (event.blockType === 'text') return MESSAGES;
    if (event.blockType === 'thinking') return THINKING;
    if (event.blockType === 'tool_call' || event.blockType === 'tool_result') return TOOLS;
    return FULL_CLIENTS_ONLY;
  }
  return Object.hasOwn(TRACE_SCOPES, event.type) ? TRACE_SCOPES[event.type]! : FULL_CLIENTS_ONLY;
}

const TREES: readonly ObserverScope[] = AGENT_TREE_SCOPES;

export function childEventScopes(event: { type?: unknown }): FrameScopes {
  const type = typeof event.type === 'string' ? event.type : '';
  if (type === 'lifecycle') return HEALTH;
  if (type === 'snapshot') return TREES;
  if (type === 'inference:speech') return ['messages', 'thinking', 'tools'];
  if (type === 'stream-ended') return MESSAGES;
  return traceScopes({ ...(event as Record<string, unknown>), type });
}

export function frameScopes(frame: WebUiServerMessage): FrameScopes {
  switch (frame.type) {
    case 'trace':
      return traceScopes(frame.event);
    case 'child-event':
      return childEventScopes(frame.event);
    case 'usage':
    case 'call-ledger':
    case 'credential-state':
    case 'host-mode':
      return ['health'];
    case 'inbound-trigger':
    case 'branch-changed':
    case 'stream-ended':
      return ['messages'];
    default:
      return FULL_CLIENTS_ONLY;
  }
}

export function streamEndedFor(event: { type: string; agentName?: unknown }): StreamEndedMessage | null {
  if (!STREAM_END_TRACES.has(event.type)) return null;
  return typeof event.agentName === 'string'
    ? { type: 'stream-ended', agentName: event.agentName }
    : { type: 'stream-ended' };
}

export function clientHolds(
  client: { auth: string; scopes: Set<ObserverScope> | null },
  scopes: FrameScopes,
): boolean {
  if (client.auth === 'full') return true;
  if (client.auth !== 'observer' || client.scopes === null || scopes === FULL_CLIENTS_ONLY) return false;
  return scopes.every((scope) => client.scopes!.has(scope));
}

export function filterEntryForScopes(
  entry: WelcomeMessageEntry,
  scopes: Set<ObserverScope>,
): WelcomeMessageEntry | null {
  if (!scopes.has('messages')) return null;
  if (scopes.has('thinking') && scopes.has('tools')) return entry;
  const blocks = entry.blocks.filter((b) => {
    if ((b.kind === 'thinking' || b.kind === 'redacted_thinking') && !scopes.has('thinking')) return false;
    if ((b.kind === 'tool_use' || b.kind === 'tool_result') && !scopes.has('tools')) return false;
    if (b.kind === 'media' && b.toolUseId !== undefined && !scopes.has('tools')) return false;
    return true;
  });
  if (blocks.length === 0 && entry.blocks.length > 0) return null;
  return { ...entry, blocks };
}

export type KeptStrings =
  | true
  | ((holder: Readonly<Record<string, unknown>>) => boolean)
  | { readonly [key: string]: KeptStrings };

export function keepNamedStrings(value: unknown, kept: KeptStrings | undefined): unknown {
  if (kept === true) return value;
  if (typeof value === 'string') return '';
  if (value === null || typeof value !== 'object') return value;
  const spec = typeof kept === 'object' ? kept : undefined;
  if (Array.isArray(value)) return value.map((item) => keepNamedStrings(item, spec));
  const holder = value as Record<string, unknown>;
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(holder)) {
    let child = spec && (Object.hasOwn(spec, key) ? spec[key] : spec['*']);
    if (typeof child === 'function') child = child(holder) ? true : undefined;
    out[key] = keepNamedStrings(item, child);
  }
  return out;
}

export const LEDGER_STRINGS: KeptStrings = {
  rows: {
    id: true,
    timestamp: true,
    kind: true,
    originEstimate: true,
    model: true,
    cache: { ttls: true, effectiveTtl: true },
    cost: { currency: true, grade: true, pricingVersion: true },
    verdict: true,
    cause: (row) => row.verdict !== 'ERROR',
    stopReason: true,
  },
  summary: { cost: { currency: true, pricingVersion: true } },
};

export const CREDENTIAL_STRINGS = {
  agent: true,
  kind: true,
  provider: true,
  windows: true,
  actions: true,
  login: true,
  lastAction: { id: true },
} satisfies KeptStrings;

export const UPDATE_STRINGS = {
  running: true,
  check: { at: true, candidate: true, costs: { version: true }, bunFloorUnmet: true },
  installing: true,
  lastInstall: { version: true, at: true },
  installed: true,
  goBack: { to: true, since: true },
  restart: { to: true, why: true, phase: true, hosts: { host: true, activeTurnAgents: true } },
  lastSwitch: { outcome: true, step: true, from: true, to: true, at: true },
} satisfies KeptStrings;

export const HEALTH_STRINGS: KeptStrings = {
  at: true,
  gate: { inferring: true },
  activeStreams: true,
  agents: {
    name: true,
    status: true,
    providerAdmission: {
      lastRecovery: { stopReason: true },
      providerWaits: { model: true, until: true, setAt: true },
    },
    refusalStats: { lastCategory: true },
  },
  credential: CREDENTIAL_STRINGS,
  compressionQuarantine: {
    '*': {
      keys: true,
      spans: { chunkSourceHash: true, firstMessageId: true, lastMessageId: true, latestOutcome: true },
    },
  },
  compressionDebt: { '*': { state: true, failure: true, mergeQuarantineKeys: true, mergeHeldIds: true } },
  loadRepair: {
    '*': {
      namespace: true,
      stateId: true,
      dropped: { id: true, reason: true, sourceRange: { first: true, last: true, firstAt: true, lastAt: true } },
    },
  },
  contextComposition: {
    '*': { planVsActual: { solver: true, ceiling: true, foldDiff: { runs: { firstChunkId: true, lastChunkId: true } } } },
  },
  contextCompositionNotKept: true,
  runtimeSettings: {
    '*': { sameRoundThinkTextPolicy: true, sameRoundThinkTextPolicySource: true, transition: true, transitionReason: true },
  },
  callLedger: LEDGER_STRINGS,
  update: UPDATE_STRINGS,
};

export const QUOTA_STRINGS: KeptStrings = {
  provider: true,
  windows: { key: true, label: true, model: true },
};

export function frameWithoutFailureText(frame: WebUiServerMessage): WebUiServerMessage {
  switch (frame.type) {
    case 'call-ledger':
      return { ...frame, ledger: keepNamedStrings(frame.ledger, LEDGER_STRINGS) as CallLedgerSnapshot };
    case 'credential-state':
      return keepNamedStrings(frame, { type: true, scope: true, ...CREDENTIAL_STRINGS }) as WebUiServerMessage;
    default:
      return frame;
  }
}

export function scopeWelcome(welcome: WelcomeMessage, scopes: Set<ObserverScope>): WelcomeMessage {
  const emptyTree = { asOfTs: Date.now(), nodes: [], callIdIndex: {} };
  const scoped: WelcomeMessage = { ...welcome };
  if (!scopes.has('health')) {
    delete scoped.callLedger;
    delete scoped.perAgentCost;
    delete scoped.hostMode;
    scoped.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    scoped.agents = welcome.agents.map((agent) => ({ ...agent, model: '' }));
  } else if (!scopes.has('ops') && welcome.callLedger) {
    scoped.callLedger = keepNamedStrings(welcome.callLedger, LEDGER_STRINGS) as CallLedgerSnapshot;
  }
  if (!scopes.has('messages')) {
    return {
      ...scoped,
      session: { ...welcome.session, name: '' },
      branch: { ...welcome.branch, name: '' },
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
    ...(TREES.every((scope) => scopes.has(scope))
      ? {}
      : { localTree: emptyTree, childTrees: [] }),
  };
}

export interface ObserverConnection {
  auth: string;
  observerKey?: string;
  label?: string;
  scopes: Set<ObserverScope> | null;
  ws: { close(code?: number, reason?: string): void };
}

/** A grant that's gone or expired closes its connections with 4401, which a
 *  client takes as final, as for a refused hello; a narrowed grant closes
 *  them with 4403, and the client connects again with the new scopes. */
export function closeConnectionsWithoutGrant(
  connections: Iterable<ObserverConnection>,
  registry: Pick<ObserverRegistry, 'liveScopes'>,
): number {
  let closed = 0;
  for (const c of connections) {
    if (c.auth !== 'observer') continue;
    const live = c.observerKey === undefined ? null : registry.liveScopes(c.observerKey);
    if (live && [...(c.scopes ?? [])].every((scope) => live.has(scope))) continue;
    try {
      if (live) c.ws.close(4403, 'observer grant narrowed');
      else c.ws.close(4401, 'observer grant gone or expired');
      closed++;
    } catch (err) {
      console.error(`[webui-observers] observer connection couldn't be closed: ${c.label ?? 'no grant'} (${errorText(err)}); each check tries again while its grant is gone, expired or narrowed`);
    }
  }
  return closed;
}
