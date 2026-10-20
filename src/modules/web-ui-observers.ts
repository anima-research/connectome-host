/**
 * Observer identity for the webui — the M2 layer of connectome
 * docs/observability.md.
 *
 * An observer is an Archipelago layer-0 principal: an ed25519 keypair,
 * human device or agent or service. Authorization is a per-agent grant file
 * (data/observers.json) that is hot-reloaded on mtime (the proven
 * discord-filters pattern: atomic tmp+rename writes, parse errors keep the
 * previous state; removing the file revokes every grant in it) and editable
 * by the agent itself through the observers
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
import { readFileSync, renameSync, statSync, lstatSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPublicKey, verify as cryptoVerify, randomBytes } from 'node:crypto';

/** Scope = event-family mask. See docs/observability.md §4. */
export const OBSERVER_SCOPES = ['health', 'ops', 'messages', 'tools', 'thinking', 'debug'] as const;
export type ObserverScope = typeof OBSERVER_SCOPES[number];

export interface ObserverGrant {
  /** `ed25519:<base64url of the raw 32-byte public key>`. The registry holds
   *  each usable grant's key in this canonical form (canonicalKey); the file
   *  may spell the same key in either base64 alphabet, padded or not. */
  key: string;
  /** Human-readable label. Testimony, not identity — never treat as verified naming. */
  label: string;
  scopes: ObserverScope[];
  /** Expiry: as the tools write it, a date in ECMAScript's own form, alone
   *  or with a time and a zone (Z or an offset), or null. The file may hold
   *  any value Date.parse reads, which verifyHello reads the same way;
   *  absent, null, empty or any other falsy value means no expiry. */
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

/** A key in canonical form: `ed25519:` and its 32 bytes as unpadded
 *  base64url. Either base64 alphabet, padded or not, reads as the same key,
 *  as b64urlToBuf decodes it; anything that isn't `ed25519:` and 32 bytes
 *  gives null. Grants are compared, and hellos looked up, in this form, so
 *  one key never counts as two. */
export function canonicalKey(key: unknown): string | null {
  if (typeof key !== 'string' || !key.startsWith('ed25519:')) return null;
  const body = key.slice('ed25519:'.length);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(body)) return null;
  const raw = b64urlToBuf(body);
  return raw && raw.length === 32 ? `ed25519:${raw.toString('base64url')}` : null;
}

/** Raw 32-byte ed25519 public key → node KeyObject (SPKI DER wrap). */
export function ed25519PublicKey(raw: Buffer) {
  const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

// ---------------------------------------------------------------------------
// File ops — the discord-mcpl filters.ts pattern, verbatim mechanics.
// ---------------------------------------------------------------------------

/** A grants file as read. A file that parses is read grant by grant: `file`
 *  holds the grants the host can use, `problems` names each entry it can't,
 *  and `doc` is the document as found, so a writer can change one entry and
 *  keep every other entry and field. A file that isn't valid JSON may be an
 *  editor's save read halfway, so it's told apart from one that can't be
 *  read or isn't a grants file at all. */
export type ObserversFileRead =
  | { kind: 'ok'; file: ObserversFile; problems: string[]; doc: GrantsDocument }
  | { kind: 'missing' }
  | { kind: 'unparsed'; problem: string }
  /** `readFailed`: reading the file failed, which may not happen again.
   *  `code`: that failure's code, such as EMFILE. */
  | { kind: 'unreadable'; problem: string; readFailed?: true; code?: string };

/** A grants document as found: an object whose `observers` entries may be
 *  of any shape, with whatever other fields it holds. */
export type GrantsDocument = Record<string, unknown> & { observers: unknown[] };

/** `problem` completes a sentence whose subject is the file, such as
 *  "isn't valid JSON (…)". This never throws: the registry reads the file
 *  from a timer, where a throw would end the process. */
export function readObserversFile(path: string): ObserversFileRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      // A link whose target is gone reads as ENOENT too, but the path is
      // there, and writing would replace the link rather than make a first file.
      return isLink(path)
        ? { kind: 'unreadable', problem: `is a link to a file that can't be read (${errorText(err)})`, readFailed: true }
        : { kind: 'missing' };
    }
    return { kind: 'unreadable', problem: `can't be read (${errorText(err)})`, readFailed: true, ...(typeof code === 'string' ? { code } : {}) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Only a syntax error can be a save read halfway. A parse that gives out
    // on a value nested too deep means the file can't be checked.
    return err instanceof SyntaxError
      ? { kind: 'unparsed', problem: `isn't valid JSON (${errorText(err)})` }
      : { kind: 'unreadable', problem: `can't be checked (${errorText(err)})` };
  }
  return checkObserversFile(parsed);
}

/** A parsed grants document read as readObserversFile reads a file. Never
 *  throws. */
export function checkObserversFile(parsed: unknown): Exclude<ObserversFileRead, { kind: 'missing' | 'unparsed' }> {
  try {
    return checkGrants(parsed);
  } catch (err) {
    // The checks read plain JSON values, but one nested deeply enough still
    // overflows JSON.stringify.
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
  // verifyHello takes the first grant for a key, so a later one for the same
  // key would never apply: an operator who added a narrower grant to restrict
  // a key would get the wider one without a word.
  const firstFor = new Map<string, number>();
  for (const [i, g] of (observers as unknown[]).entries()) {
    const wrong = entryProblems(i, g);
    // Two spellings of one key are one key.
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

/** What makes one entry unusable, each naming the entry by position and
 *  label; none for a grant the host can use. */
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
  // verifyHello reads a falsy expiry as no end, and expires a grant once
  // Date.parse(expires) is past, so an expiry it can't parse would never
  // take effect. This check reads it the same way.
  const { expires } = grant;
  if (expires && !Number.isFinite(parseDate(expires))) {
    problems.push(`${which} has an expiry that isn't a date: ${shown(expires)}`);
  }
  if (!Array.isArray(grant.scopes)) {
    problems.push(`${which} has no list of scopes`);
    return problems;
  }
  if (grant.scopes.length === 0) {
    // A grant of nothing would still turn the observer gate on.
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

/** Date.parse, which converts an object through its own toString or valueOf
 *  and throws when neither can be called; such a value is no date. */
function parseDate(value: unknown): number {
  try {
    return Date.parse(value as string);
  } catch {
    return NaN;
  }
}

/** A value as a problem quotes it: as JSON, except a number JSON can't hold,
 *  which JSON.stringify would show as null. */
function shown(value: unknown): string {
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value);
}

/** An entry as the problems name it: by position, and by label if it has one. */
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

/** The usable grants, or null for a file that's missing, can't be read or
 *  checked, isn't valid JSON or isn't a grants file. */
export function loadObserversFile(path: string): ObserversFile | null {
  const read = readObserversFile(path);
  return read.kind === 'ok' ? read.file : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function saveObserversFile(path: string, file: ObserversFile): void {
  // Through a link, write the file it points to, so the link stays a link.
  const target = isLink(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, keepNonFinite, 2) + '\n');
  renameSync(tmp, target); // atomic — mtime pollers never read a half-write
}

/** JSON has no Infinity: a number too large for it, such as 1e309, parses as
 *  Infinity, and JSON.stringify writes that as null. An expiry the viewer
 *  can't read would come back as no expiry, and the grant would admit its
 *  key with no end. Written as text instead, every such value keeps its
 *  meaning to both readers: "Infinity" is no date, no scope and no key,
 *  and is as truthy as Infinity. */
function keepNonFinite(_key: string, value: unknown): unknown {
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
}

/** What the registry compares between checks: the file's mtime, ctime,
 *  inode and size, so a file replaced by one with the same mtime (cp -p,
 *  rsync -t) or made unreadable in place (chmod) reads as changed. When the
 *  stat fails, why, as the log names it. */
export function observersFileStat(path: string): { sig: string } | { problem: string } {
  try {
    const s = statSync(path);
    return { sig: `${s.mtimeMs}:${s.ctimeMs}:${s.ino}:${s.size}` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // A link whose target is gone stats as missing too, but the path is there.
      return { problem: isLink(path) ? `is a link to a file that can't be read (${code})` : 'is gone' };
    }
    return { problem: `can't be read (${code ?? (err instanceof Error ? err.message : String(err))})` };
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
  /** The file as the last read found it (observersFileStat), or null to
   *  read it again at the next check. */
  private lastSig: string | null = null;
  /** Whether the file was there when last found, so its removal is said
   *  once, whatever the file held. */
  private present = false;
  /** Checks in a row that haven't found the file. */
  private misses = 0;
  private poll: ReturnType<typeof setInterval> | null = null;
  /** The last problem logged, so a file read again at every check is named
   *  once rather than every 3 s. */
  private lastSaid: string | null = null;

  /** `pollMs` is how often the file is checked; tests shorten it. */
  constructor(private readonly path: string, private readonly pollMs = 3000) {}

  /** `onCheck` runs after every check of the file, whether or not it
   *  changed, so a caller can act on grants that expire with time. */
  start(onCheck?: () => void): void {
    const at = observersFileStat(this.path);
    this.present = 'sig' in at;
    // A file that's there but can't be reached is named once, as a check
    // names it; a host that never had the file says nothing.
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

  /** One check of the file: read it again if it changed, and take no grants
   *  from it once it's gone. */
  private check(): void {
    const at = observersFileStat(this.path);
    if ('problem' in at) {
      this.missed(at.problem);
      return;
    }
    if (at.sig !== this.lastSig) {
      const read = readObserversFile(this.path);
      // Gone between the stat and the read, or a read that failed (EIO,
      // EMFILE, EACCES): a miss, as a failed stat is, so a failure that
      // passes doesn't take every grant away, and with them every observer's
      // sessions and connections.
      if (read.kind === 'missing' || (read.kind === 'unreadable' && read.readFailed === true)) {
        this.missed(read.kind === 'missing' ? 'is gone' : read.problem);
        return;
      }
      this.load(at.sig, read, 'reload');
    }
    this.misses = 0;
    this.present = true;
  }

  /** A check that didn't find the file. It gives no grants, as the tools
   *  read a missing file, once two checks in a row haven't found it. The
   *  host's and the tools' writes are atomic renames, so they never leave it
   *  missing; an editor's save that removes the file before writing it does,
   *  for milliseconds, and is back by the next check, so it changes nothing. */
  private missed(problem: string): void {
    if (++this.misses < 2) return;
    this.lastSig = null;
    this.file = null;
    if (this.present) {
      this.present = false;
      this.say(`[webui-observers] ${this.path} ${problem} — admitting no grants from it`);
    }
  }

  /** Take what a read of the file gives. A read that failed, a file gone
   *  between the stat and the read at start, or JSON a save in progress
   *  left half-written, is read again at the next check, since the write
   *  that finishes it can leave the stat as it was; anything else waits for
   *  the file to change. */
  private load(sig: string, read: ObserversFileRead, when: 'start' | 'reload'): void {
    const again = read.kind === 'unparsed' || read.kind === 'missing'
      || (read.kind === 'unreadable' && read.readFailed === true);
    this.lastSig = again ? null : sig;
    this.take(read, when);
  }

  /** Take what a read of the file gives. A file that parses gives exactly its
   *  usable grants, and the log names each entry it can't use. A file that
   *  isn't valid JSON keeps the grants a reload had, since an editor's save
   *  can be read halfway and the next check reads it whole; at start it gives
   *  none. Anything else gives none, and says so, a file removed between the
   *  stat and the read included. */
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

  /** Log a problem once while it lasts. */
  private say(line: string): void {
    if (line !== this.lastSaid) console.error(line);
    this.lastSaid = line;
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

  /** The scopes of the grant for `key`, a canonical key, while the file
   *  holds it and it hasn't expired, as verifyHello reads both; otherwise
   *  null. Sessions and open connections are checked against this, so they
   *  end with their grant. */
  liveScopes(key: string, now = Date.now()): Set<ObserverScope> | null {
    const grant = this.grants().find((g) => g.key === key);
    if (!grant) return null;
    if (grant.expires && Date.parse(grant.expires) < now) return null;
    return new Set(grant.scopes);
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

    // The registry holds canonical keys, so a client's spelling of its key
    // finds the grant however the file spelled it.
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
  private sessions = new Map<string, ObserverSession & { expiresAt: number; key?: string }>();

  /** A session is full (password) or an observer's, minted for the grant
   *  `key` names as the registry holds it, so it can end with that grant. */
  mint(scopes: Set<ObserverScope>, opts: { full: true } | { key: string }): string {
    // Opportunistic sweep — the map stays tiny (one entry per auth event).
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

  /** Narrow every observer session to the scopes its grant still has, and
   *  end those whose grant is gone, expired or keeps none of their scopes;
   *  run after each check of the grants file, which is when the registry
   *  learns of a revoke, a narrowing or the file's removal. A lookup reads
   *  what the last check left. A session's scopes only ever shrink: a grant
   *  widened or given again later is a new decision, which the observer's
   *  next hello takes up in a new session. Returns how many it ended. A
   *  session already past its 12 hours ended on its own, so it's left alone
   *  and not counted: lookup refuses it, and mint sweeps it. */
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

/** Keep only the session's scopes that `live` still holds, storing the
 *  narrowing as a new set, since the hello's connection holds the one the
 *  session was minted with; false when the grant is gone or expired, or
 *  keeps none of the session's scopes, so the session reaches nothing. */
function narrow(s: { scopes: Set<ObserverScope> }, live: Set<ObserverScope> | null): boolean {
  if (!live) return false;
  if ([...s.scopes].some((scope) => !live.has(scope))) {
    const kept = new Set([...s.scopes].filter((scope) => live.has(scope)));
    if (kept.size === 0) return false;
    s.scopes = kept;
  }
  return true;
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

/** An open connection as the grant sweep sees it. */
export interface ObserverConnection {
  auth: string;
  /** The grant a key-authenticated observer connected with, as the registry
   *  holds its key. */
  observerKey?: string;
  /** That grant's label, as the hello gave it, which the log names it by. */
  label?: string;
  scopes: Set<ObserverScope> | null;
  ws: { close(code?: number, reason?: string): void };
}

/** Close each observer connection whose grant is gone, expired or narrowed,
 *  so a revoke, an expiry or the file's removal ends open connections as it
 *  ends new hellos. A grant that's gone or expired closes with 4401, which
 *  the web client takes as final, as it does a refused hello. A narrowed
 *  grant closes with 4403 rather than narrowing the connection, since its
 *  open subscriptions were checked against the old scopes, and the client
 *  connects again with the new ones. Returns how many it closed. */
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
      // One socket's failure doesn't keep the sweep from the rest.
      console.error(`[webui-observers] observer connection couldn't be closed: ${c.label ?? 'no grant'} (${errorText(err)}); each check tries again while its grant is gone, expired or narrowed`);
    }
  }
  return closed;
}
