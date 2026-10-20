/**
 * Agent identity — the agent's own archipelago-home principal (connectome
 * docs/home-node.md §4).
 *
 * Two audiences, deliberately separated:
 *
 * HOST-FACING (this module's public methods): the deployment holds an
 * ed25519 keypair in the data dir; `accessFor(audience)` exchanges a
 * key-proof at the home node for a short-lived aid1 token, and
 * `httpAuthFor(audience)` wraps it for HTTP. This is plumbing other host
 * pieces call — the MCPL transport's per-dial credential provider, future
 * HTTP helpers. Credentials live and die HERE.
 *
 * AGENT-FACING (utilities, via the `utils` meta-tool): deliberately small
 * and deliberately boring — `status` ("who am I registered as, where is
 * that recognized") and `accept_invite` ("register with an invitation code
 * from your operator"). No tokens, keys, proofs, or signing in any
 * agent-visible name, description, or result: the agent asks for access by
 * name (`mcpl_deploy … access: "eidoverse"`); the host does the rest. This
 * is both hygiene (credentials never enter model context, so they never
 * enter chronicles, compression, or channels) and framing (an agent
 * narrating credential mechanics reads as exfiltration to safety
 * classifiers — so it simply never has them to narrate).
 *
 * Utilities-only module: enrollment is one-time; it costs no tool slots.
 * Wire statements per the home-node spec (archipelago-home
 * src/statements.ts is the source of truth — re-copy, don't fork).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  createHash,
  type KeyObject,
} from 'node:crypto';
import {
  WorkspaceReadError,
  type Module,
  type ModuleContext,
  type ToolCall,
  type ToolResult,
  type ToolDefinition,
  type WorkspaceModule,
} from '@animalabs/agent-framework';
import { unknownToolResult } from './unknown-tool.js';

/** A disk read's refusal that means disk has no file at the path, where
 *  the workspace's own copy stands in: not_found with ENOENT (nothing there,
 *  or a link that leads nowhere), ENOTDIR (a parent that's a file) or
 *  ENAMETOOLONG (a name disk can't hold), and mount_unavailable with ENOENT
 *  or ENOTDIR (the mount's directory gone, or a file in its place). A gone
 *  mount directory reaches agent-framework 0.22.3's read as not_found with
 *  ENOENT, since it lstats the path before it resolves the root, and a read
 *  that resolves the root first reports it as mount_unavailable with ENOENT.
 *  mount_unavailable with any other errno, or none, is a root the read
 *  couldn't resolve or trust, where disk may hold a file it couldn't reach,
 *  so the upload is refused. On a mount that doesn't follow links,
 *  agent-framework 0.22.3 reads a link among the path's directories that
 *  leads nowhere or to a file as not_found (ENOENT or ENOTDIR), so the
 *  workspace's copy stands in, and its release with
 *  anima-research/agent-framework#468 refuses either as parent_symlink, so
 *  the upload is refused there. */
function diskHasNoFile(error: WorkspaceReadError): boolean {
  const gone = ['ENOENT', 'ENOTDIR'];
  if (error.code === 'mount_unavailable') return gone.includes(error.errno ?? '');
  return error.code === 'not_found' && [...gone, 'ENAMETOOLONG'].includes(error.errno ?? '');
}

/** What the agent can do about any other refusal of a disk read, by its code.
 *  `parent_symlink` comes from agent-framework's release with
 *  anima-research/agent-framework#468, past the version this host's types
 *  come from, so it's matched as a string. */
function diskRemedy(error: WorkspaceReadError): string {
  switch (error.code as string) {
    case 'directory':
      return 'Name a file, not a directory.';
    case 'symlink':
      // The workspace's tools don't show where a link points, so the agent may not know.
      return 'It\'s a link, and this mount doesn\'t follow links. If you know it points to a file in the workspace, name ' +
        'that file by its own path; otherwise an upload can\'t send it, though your operator can put the file in the workspace.';
    case 'escape':
      // A mount's own check: the file may lie in another mount, which the
      // reason doesn't say.
      return 'It leads, through a link, outside this mount, and an upload sends only a file that lies inside the mount ' +
        'it\'s named through. If you know the file lies in another mount, name it by its path there; otherwise your ' +
        'operator can put it in the workspace.';
    case 'parent_symlink':
      // The read's own reason names the link and, where it leads somewhere,
      // its target. Only for a directory does it add the setting the mount's
      // host can change, which is how the agent can tell that case: there
      // the file can be named by its path through the directory, and
      // following links would help. Elsewhere neither would. The route's
      // real-read test pins those words.
      return 'A directory on its path is a link, and this mount doesn\'t follow links. If the link leads to a ' +
        'directory, which the reason shows by saying the mount\'s host can set followSymlinks, name the file by its ' +
        'path there. Otherwise ask your operator, giving them this reason.';
    case 'changed':
      return 'It changed while it was being read, and calling again reads it afresh.';
    default:
      return 'Disk refused the read, which is the host\'s to fix: ask your operator, giving them this reason.';
  }
}

/**
 * A failure with a sentence for each of its readers. `message` is for whoever
 * runs the host, who reads it in a log: accessFor's reaches them in the MCPL
 * dial's line ("access provider failed (<message>) — dialing with configured
 * fallback"), written again on every reconnect, so it gives no advice meant
 * for the agent and may name the host's files. `forAgent` is what an
 * identity utility tells the agent, and names no host path and nothing of the
 * credentials.
 */
export class IdentityError extends Error {
  constructor(message: string, readonly forAgent: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

export interface IdentityModuleConfig {
  /** ed25519 PKCS#8 PEM, generated on first use, 0600. dataDir-anchored:
   *  identity is per-deployment, not per-session. */
  keyPath: string;
  /** Home node domain (the trust anchor), e.g. `id.animalabs.ai`. */
  home: string;
  /** Audience assumed when none is named. */
  defaultAudience?: string;
  /**
   * Services reachable through the `request` utility: audience name → API
   * base URL. The allowlist IS the security boundary — the host only ever
   * attaches standing access to these bases, so the utility can't be
   * steered at arbitrary URLs. Merged over built-in defaults for the
   * animalabs services.
   */
  services?: Record<string, string>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Known services when anchored at the animalabs home — a recipe can extend
 *  or override via `services`. */
const DEFAULT_SERVICES: Record<string, string> = {
  orrery: 'https://orrery.animalabs.ai',
  eidoverse: 'https://eidoverse.animalabs.ai',
};

/** How long a fetched service directory is trusted before a background-ish
 *  refresh. Short by design: "a service changed" should reach residents in
 *  about a minute, and an unknown name forces a refresh immediately anyway. */
const SERVICES_TTL_MS = 60_000;
const SERVICES_TIMEOUT_MS = 5_000;
/** How long a call to the identity service (/token, /enroll) may take before
 *  it counts as no reply: one that hangs would otherwise stall an MCPL dial,
 *  or keep a registration under way and refuse every later one. */
const IDENTITY_TIMEOUT_MS = 15_000;

/** HTTP methods the `request` utility sends. The security boundary is the
 *  service allowlist with host-attached access, and each service authorizes
 *  every request itself; this list just names the verbs services route.
 *  The advertised schema and the runtime check both read it. */
const REQUEST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const REQUEST_BODY_MAX = 256 * 1024;
/** Uploads are bytes the host streams from a workspace file, not text the
 *  model wrote, so the small JSON-body cap would be the wrong limit: a track
 *  or a render is legitimately megabytes. Still bounded — one call should not
 *  be able to push an unbounded file at a service. */
const UPLOAD_BODY_MAX = 64 * 1024 * 1024;

/** Enough to label the common uploads honestly; anything else is
 *  application/octet-stream unless the caller says otherwise. */
const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
  opus: 'audio/opus', m4a: 'audio/mp4', aac: 'audio/aac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  json: 'application/json', txt: 'text/plain', md: 'text/markdown',
  pdf: 'application/pdf', zip: 'application/zip',
};

function guessContentType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  // The table's own entry, never a name every object inherits (constructor).
  return Object.hasOwn(CONTENT_TYPES, ext) ? CONTENT_TYPES[ext] : 'application/octet-stream';
}
const RESPONSE_INLINE_MAX = 24 * 1024;
const RESPONSE_BODY_MAX = 64 * 1024 * 1024;

/** Persisted beside the key after a successful registration. */
interface IdentityRecord {
  sub: string;
  name: string;
  home: string;
  enrolledAt: string;
}

/** A registration the identity service answered 200 for, held in memory
 *  because this host couldn't record it: its record couldn't be saved, or
 *  no id could be read from the reply, when `sub` is null. */
type HeldRegistration = Omit<IdentityRecord, 'sub'> & { sub: string | null };

/**
 * What this process knows of a registration beyond its record: one held in
 * memory because it couldn't be recorded, until its record file holds one,
 * and whether one is under way. It is kept per record file rather than per
 * module, since the host builds a new IdentityModule at each session switch
 * while a registration belongs to the deployment: a session switch keeps
 * both, and a restart ends them.
 */
interface RegistrationState {
  held: HeldRegistration | null;
  enrolling: boolean;
}
const registrationStates = new Map<string, RegistrationState>();

function ok(data: unknown): ToolResult {
  return { success: true, data };
}
function fail(text: string): ToolResult {
  return { success: false, error: text, isError: true };
}

/** A clause as a sentence's end: one full stop, whatever it ended with. */
const sentence = (text: string): string => `${text.trim().replace(/\.+$/, '')}.`;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** What names an error without its words, which can carry host paths: its
 *  code where it has one (EACCES), else its class. */
const codeOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.name : 'a thrown value that isn\'t an error';
};

/** An answer to /token that a later try may not get: the identity service is
 *  rate limiting, or the fault is its own. Read from the status, never from
 *  the error's words. */
const transient = (status: number): boolean => status === 429 || status >= 500;

/** A value an argument was given, quoted back short enough to read. */
function shown(value: unknown): string {
  if (value === undefined) return 'nothing';
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** What the agent reads when this host's key can't be had: the fix is the
 *  host's, and the log has why. It names no key, path or error code. */
const IDENTITY_UNLOADED =
  'this host\'s identity couldn\'t be loaded. It\'s the host\'s to fix: ask your operator, who can find the reason in ' +
  'the host\'s log';

/** What status and a second registration say of a registration held in memory. */
const HELD_NOTE =
  'This host holds this registration only until it restarts, since it couldn\'t record it. If your operator hasn\'t ' +
  'recorded it yet, ask them to, before the host restarts.';

export class IdentityModule implements Module {
  readonly name = 'identity';
  private readonly recordPath: string;

  /** Last good service directory from the home node, and when we got it. */
  private servicesFromHome: Record<string, string> = {};
  private servicesFetchedAt = 0;
  private servicesInflight: Promise<void> | null = null;

  /** This deployment's registration state in this process: a registration
   *  held in memory, and whether one is under way, so that a second one is
   *  refused until it ends. Shared by every module made for the same record
   *  file (see RegistrationState). */
  private readonly state: RegistrationState;

  constructor(private readonly config: IdentityModuleConfig) {
    this.recordPath = config.keyPath.replace(/\.pem$/, '') + '.json';
    const key = resolve(this.recordPath);
    let state = registrationStates.get(key);
    if (!state) registrationStates.set(key, (state = { held: null, enrolling: false }));
    this.state = state;
  }

  private ctx: ModuleContext | null = null;

  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> { this.ctx = null; }

  getTools(): ToolDefinition[] {
    return []; // utilities-only, by design — see module header
  }

  getUtilities(): ToolDefinition[] {
    return [
      {
        name: 'status',
        description:
          'Your registered identity: the name and id services know you by, and which ' +
          'identity service vouches for it. Access to networked places (worlds etc.) is ' +
          'managed by the host from this — you never handle credentials yourself.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'request',
        description:
          'Call a connected service’s API (e.g. "orrery") with your standing access ' +
          'attached by the host — nothing for you to obtain, renew, or handle; renewal ' +
          'is automatic. Give the service name and a path; returns {status, body}. ' +
          'For binary responses, pass saveAs with a workspace path (e.g. files/artifacts/image.png). ' +
          'To send a file — audio, images, anything large — pass fromFile with a workspace ' +
          'path instead of body; the host streams the bytes, so the file never has to pass ' +
          'through what you are writing.',
        inputSchema: {
          type: 'object',
          properties: {
            service: { type: 'string', description: 'Service name, e.g. "orrery". Unknown names list what is available.' },
            path: { type: 'string', description: 'API path starting with "/", e.g. "/api/ops".' },
            method: { type: 'string', enum: [...REQUEST_METHODS], description: 'Default GET.' },
            body: { type: 'object', description: 'JSON body; sent with any method other than GET.' },
            fromFile: { type: 'string', description: 'Workspace path whose raw bytes become the request body, e.g. files/music/track.mp3. Use instead of body for uploads, with any method other than GET; not combinable with body.' },
            contentType: { type: 'string', description: 'Content-Type for fromFile uploads. Inferred from the file extension when omitted.' },
            saveAs: { type: 'string', description: 'Optional workspace path for the raw response bytes, e.g. files/artifacts/image.png. Required to retrieve binary bodies without loss.' },
          },
          required: ['service', 'path'],
        },
      },
      {
        name: 'accept_invite',
        description:
          'Register with the identity service using an invitation code from your operator. ' +
          'One-time: it establishes the name services will know you by. After this, the ' +
          'host handles access automatically (e.g. mcpl-admin--mcpl_deploy with an `access` name).',
        inputSchema: {
          type: 'object',
          properties: {
            invite: { type: 'string', description: 'Invitation code from your operator.' },
            name: { type: 'string', description: 'The display name you want (must be unused).' },
          },
          required: ['invite', 'name'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case 'status':
          return this.status();
        case 'accept_invite':
          return await this.acceptInvite(call.input as { invite?: unknown; name?: unknown });
        case 'request':
          return await this.request(call.input as {
            service?: unknown; path?: unknown; method?: unknown; body?: unknown; fromFile?: unknown; contentType?: unknown; saveAs?: unknown;
          });
        default:
          return unknownToolResult(this, call.name);
      }
    } catch (err) {
      // request and accept_invite catch what fails once they've sent
      // anything (the call to a service, the registration), each saying what
      // it knows of the outcome, so a throw that reaches here came before
      // anything was sent: a registration record that can't be read, a key
      // that can't be read, made or used, or the workspace failing a read.
      // The log gets the whole error. An IdentityError carries the agent's
      // sentence; any other error can come from anywhere and name a host
      // path, so the agent gets what names it without its words.
      console.error(`[identity] ${call.name} failed: ${errorText(err)}`);
      const before = call.name === 'status' ? '' : ' before anything was sent';
      if (err instanceof IdentityError) return fail(`identity--${call.name} failed${before}: ${sentence(err.forAgent)}`);
      return fail(
        `identity--${call.name} failed${before} (${codeOf(err)}). It's the host's to fix, so if it keeps happening, ask ` +
        'your operator.',
      );
    }
  }

  async onProcess(): Promise<Record<string, never>> {
    return {};
  }

  // ────────────────────────────────────────────────────────────────────────
  // Host-facing API — credential plumbing. Nothing below ever reaches model
  // context; callers (MCPL dial provider, HTTP helpers) consume the values
  // outside the agent's view.
  // ────────────────────────────────────────────────────────────────────────

  /** True once this deployment holds a registered principal. Throws an
   *  IdentityError when its record can't be read. */
  isEnrolled(): boolean {
    return this.record() !== null;
  }

  /** The registered principal id (`agent:<name>@<domain>`), if any: null too
   *  for a registration held in memory whose reply named no id this host
   *  could read. Throws an IdentityError when the record can't be read. */
  sub(): string | null {
    return this.record()?.sub ?? null;
  }

  /**
   * Exchange a key-proof for a fresh aid1 token for `audience`. Called per
   * MCPL dial (connect + every reconnect) and by HTTP helpers — which is
   * what lets audience tokens be short-lived. Throws an IdentityError
   * whenever it can't give access, with a sentence for each reader:
   * its message for whoever runs the host, who reads it in the MCPL dial's
   * log line on every reconnect (agent-framework's transport logs a failed
   * provider and dials without it, so the agent never sees it there), and
   * `forAgent` for the agent, through `request`.
   */
  async accessFor(audience?: string): Promise<string> {
    const aud = audience ?? this.config.defaultAudience;
    const home = this.config.home;
    if (!aud) {
      throw new IdentityError(
        'access was asked for without naming an audience, and the identity module sets no default ' +
          '(modules.identity.audience in the recipe)',
        'this host asked for access without naming a service. It\'s the host\'s to fix: ask your operator',
      );
    }
    if (!this.record()) {
      // What the host knows: a registration it lost the record of reads the
      // same as none, short of asking the service.
      const none = `no registration with the identity service at ${home} is recorded on this host, so it has no access ` +
        `to give "${aud}"`;
      throw new IdentityError(
        `${none}; registering takes an invitation code, which the agent redeems through identity--accept_invite`,
        `${none}. Registering takes an invitation code from your operator: run identity--accept_invite through utils ` +
          'with the code and a name',
      );
    }
    const timestamp = new Date().toISOString();
    const { id, proof } = this.prove(`archipelago-token|v1|${home}|${aud}|${timestamp}`);
    let reply: { status: number; json: Record<string, unknown> };
    try {
      reply = await this.post('/token', { id, audience: aud, timestamp, proof });
    } catch (err) {
      const unreachable = `the identity service at ${home} couldn't be reached for access to "${aud}" (${errorText(err)})`;
      throw new IdentityError(unreachable, `${unreachable}. Try again shortly`);
    }
    const { status, json } = reply;
    if (status === 200 && typeof json.token === 'string') return json.token;
    if (status === 200) {
      // The service answered that it gave access, but its reply couldn't be read.
      const unread = `the identity service at ${home} answered 200 for access to "${aud}", but its reply couldn't be read`;
      throw new IdentityError(unread, `${unread}. Try again shortly`);
    }
    const error = String(json.error ?? 'no reason given');
    if (transient(status)) {
      const busy = `the identity service at ${home} couldn't give access to "${aud}" just now (${status}: ${error})`;
      throw new IdentityError(busy, `${busy}. Try again shortly`);
    }
    const refused = `the identity service at ${home} refused access to "${aud}" (${status}: ${error})`;
    throw new IdentityError(
      refused,
      `${refused}. identity--status shows this host's registration. If this host should have that access, ask your ` +
        'operator, giving them the reason',
    );
  }

  /** Authorization header for HTTP calls to an audience's API. */
  async httpAuthFor(audience?: string): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.accessFor(audience)}` };
  }

  // ── key material ──

  /** The key, as loadOrCreateKey gives it, or an IdentityError: the log gets
   *  the key file's path and the whole error. The agent gets neither, nor the
   *  error's code, since it can't act on any of them: the fix is the host's.
   *  A key file missing beside a registration this host records or holds is
   *  refused, not made anew: the service holds that registration under the
   *  old key, and would refuse every access signed with a new one. */
  private identityKey(): { privateKey: KeyObject; id: string } {
    if (!existsSync(this.config.keyPath)) {
      const rec = this.record();
      if (rec) {
        // A registration held in memory has no record file to remove: the
        // host forgets it when it restarts.
        const rotate = this.state.held
          ? 'restart the host, which forgets the registration it holds in memory, and register it again'
          : 'remove the record as well and register this host again';
        throw new IdentityError(
          `this host's registration as "${rec.name}" with ${rec.home} is ` +
            `${this.state.held ? 'held in memory' : `recorded at ${this.recordPath}`}, but its identity key at ` +
            `${this.config.keyPath} is missing, so no new key was made: the service holds the registration under the ` +
            `old key and would refuse every access signed with a new one. Restore the key file. To rotate the key on ` +
            `purpose, ${rotate} with an invitation code; the service keeps the old registration, so the new one needs ` +
            'a name the old one doesn\'t hold',
          IDENTITY_UNLOADED,
        );
      }
    }
    try {
      return this.loadOrCreateKey();
    } catch (err) {
      throw this.keyFailure(err);
    }
  }

  /** A key that couldn't be read, made or used, as an IdentityError. */
  private keyFailure(err: unknown): IdentityError {
    return new IdentityError(
      `this host's identity key at ${this.config.keyPath} couldn't be read, made or used: ${errorText(err)}`,
      IDENTITY_UNLOADED,
    );
  }

  /** This host's key id and its proof of `statement`. A key that can't be
   *  had is identityKey's IdentityError. One that loads is ed25519's, which
   *  signs, so signing has no failure of its own to word. */
  private prove(statement: string): { id: string; proof: string } {
    const key = this.identityKey();
    return { id: key.id, proof: cryptoSign(null, Buffer.from(statement, 'utf8'), key.privateKey).toString('base64url') };
  }

  private loadOrCreateKey(): { privateKey: KeyObject; id: string } {
    let privateKey: KeyObject;
    if (existsSync(this.config.keyPath)) {
      privateKey = createPrivateKey(readFileSync(this.config.keyPath, 'utf8'));
      // The identity service's ids and proofs are ed25519's, so a key of
      // another type is refused where it loads, which status meets too,
      // rather than where it signs. The file is the operator's to replace:
      // nothing is made over it or beside it.
      if (privateKey.asymmetricKeyType !== 'ed25519') {
        throw new Error(`it holds a key of type ${privateKey.asymmetricKeyType}, not ed25519`);
      }
    } else {
      privateKey = generateKeyPairSync('ed25519').privateKey;
      mkdirSync(dirname(this.config.keyPath), { recursive: true });
      writeFileSync(this.config.keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    }
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
    return { privateKey, id: `ed25519:${spki.subarray(spki.length - 32).toString('base64url')}` };
  }

  /**
   * This host's registration: the record file's, or else one this process
   * holds in memory because it couldn't record it. Null only when there is
   * neither. The file comes first, since the operator is asked to record a
   * held registration by hand while the host runs: once the file holds a
   * registration, the hold is dropped, and the registration reads as one the
   * host recorded itself, a record removed later included. A record that
   * differs from the hold is the operator's to correct: every field of the
   * hold is in the log line written when it began (the record to write by
   * hand), and access signs with this host's key whatever the record names.
   * With nothing held, a record file that can't be read, or holds no
   * registration, throws (recordFile).
   */
  private record(): IdentityRecord | HeldRegistration | null {
    let rec: IdentityRecord | null;
    try {
      rec = this.recordFile();
    } catch (err) {
      if (this.state.held) return this.state.held;
      throw err;
    }
    if (rec) this.state.held = null;
    return rec ?? this.state.held;
  }

  /**
   * The record file's registration. Null only when there is no record file.
   * A record file that can't be read, or holds no registration, throws an
   * IdentityError: whether this host is registered is then unknown, which is
   * never "not registered", since registering again would be refused if it is.
   */
  private recordFile(): IdentityRecord | null {
    let text: string;
    try {
      text = readFileSync(this.recordPath, 'utf8');
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'ENOENT') return null;
      throw this.unreadableRecord(errorText(err));
    }
    let rec: unknown;
    try {
      rec = JSON.parse(text);
    } catch {
      throw this.unreadableRecord('it isn\'t JSON');
    }
    const fields = rec as Partial<IdentityRecord> | null;
    if (typeof fields !== 'object' || fields === null || typeof fields.sub !== 'string' || typeof fields.name !== 'string') {
      throw this.unreadableRecord('it holds no registration');
    }
    return fields as IdentityRecord;
  }

  /** The log gets why the record couldn't be read; the agent, as for the key,
   *  that it's the host's to fix, since it can't act on the reason. */
  private unreadableRecord(detail: string): IdentityError {
    return new IdentityError(
      `this host's registration record ${this.recordPath} couldn't be read (${detail}), so whether this host is ` +
        'registered is unknown until it is fixed or restored',
      'this host\'s registration record couldn\'t be read, so whether this host is registered is unknown. It\'s the ' +
        'host\'s to fix: ask your operator, who can find the reason in the host\'s log',
    );
  }

  /** How the operator records a registration by hand, for the log: the
   *  record's path and what to write there. Without the id, the JSON leaves
   *  `sub` out and says to add it, so a copy made as written reads as holding
   *  no registration, rather than loading with a stand-in for the id. */
  private recordByHand(name: string, sub: string | null, enrolledAt: string): string {
    const home = this.config.home;
    if (sub !== null) return `To record it, write ${JSON.stringify({ sub, name, home, enrolledAt })} to ${this.recordPath}.`;
    return `To record it, write ${JSON.stringify({ name, home, enrolledAt })} to ${this.recordPath}, adding "sub" with ` +
      'the id the identity service holds for this registration.';
  }

  private saveRecord(rec: IdentityRecord): void {
    writeFileSync(this.recordPath + '.tmp', JSON.stringify(rec, null, 2) + '\n');
    renameSync(this.recordPath + '.tmp', this.recordPath);
  }

  private async post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const f = this.config.fetchImpl ?? fetch;
    const res = await f(`https://${this.config.home}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    // A reply whose body isn't a JSON object (none, unreadable, null, an
    // array) reads as one with no fields: its readers then find no id or
    // reason, rather than throwing after the service may have acted. A body
    // that can't be read keeps the status that arrived, the service's answer.
    const parsed: unknown = await res.json().catch(() => null);
    const json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return { status: res.status, json };
  }

  // ── agent-facing utilities ──

  private status(): ToolResult {
    // Key material is created lazily here too, so status can be the first
    // call a host gets, and none of it surfaces in the result. A key or a
    // record that can't be had fails status, as it fails every utility.
    this.identityKey();
    const rec = this.record();
    return ok(
      rec
        ? {
            registeredAs: rec.name,
            id: rec.sub,
            recognizedBy: rec.home,
            since: rec.enrolledAt,
            note: this.state.held
              ? HELD_NOTE
              : 'Access to services is handled by the host automatically (e.g. mcpl-admin--mcpl_deploy with an `access` name).',
          }
        : {
            // What the host knows: a registration it lost the record of
            // reads the same as none, short of asking the service.
            registeredAs: null,
            note: `No registration with ${this.config.home} is recorded on this host. To register, ask your operator for an ` +
              'invitation code, then run identity--accept_invite through utils with it.',
          },
    );
  }

  /** Audience → API base, resolved from the home node's `/services` directory
   *  at runtime. The archipelago's service list belongs to the trust anchor,
   *  not to a constant compiled into every host: a service added at the home
   *  node reaches every resident without a restart or a recipe edit.
   *
   *  Layering, most specific last: fetched directory → built-in defaults for
   *  anything the directory omits → recipe `services` (explicit local config
   *  still wins, for testing and for hosts anchored elsewhere).
   *
   *  Never throws: a home node that is down, slow, or rate-limiting leaves the
   *  last good directory in place (or the built-in defaults on a cold start),
   *  so losing discovery degrades to today's behaviour rather than to an
   *  outage. */
  private async resolveServices(opts: { force?: boolean } = {}): Promise<Record<string, string>> {
    const now = Date.now();
    const fresh = this.servicesFetchedAt > 0 && now - this.servicesFetchedAt < SERVICES_TTL_MS;
    if (!opts.force && fresh) return this.layerServices();
    // Collapse concurrent refreshes onto one request.
    if (!this.servicesInflight) {
      const f = this.config.fetchImpl ?? fetch;
      this.servicesInflight = (async () => {
        try {
          const res = await f(`https://${this.config.home}/services`, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(SERVICES_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`status ${res.status}`);
          const json = (await res.json()) as { services?: Record<string, unknown> };
          const map: Record<string, string> = {};
          for (const [name, base] of Object.entries(json.services ?? {})) {
            if (typeof base === 'string' && /^https:\/\//.test(base)) map[name] = base;
          }
          this.servicesFromHome = map;
          this.servicesFetchedAt = Date.now();
        } catch (err) {
          // Keep whatever we had; note it once per failure for the operator.
          console.error(
            `[identity] service directory refresh failed (${this.config.home}): ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          this.servicesInflight = null;
        }
      })();
    }
    await this.servicesInflight;
    return this.layerServices();
  }

  private layerServices(): Record<string, string> {
    return { ...DEFAULT_SERVICES, ...this.servicesFromHome, ...this.config.services };
  }

  /** The agent-facing HTTP seam for non-MCPL services (Orrery et al.): the
   *  host resolves the base URL from the directory, fetches fresh access,
   *  attaches it, and returns only {status, body}. The credential exists
   *  for the duration of one fetch, outside model context. Every refusal
   *  before the fetch says nothing was sent; once the request may have gone
   *  out, each failure says what is known of its outcome. */
  private async request(input: {
    service?: unknown;
    path?: unknown;
    method?: unknown;
    body?: unknown;
    fromFile?: unknown;
    contentType?: unknown;
    saveAs?: unknown;
  }): Promise<ToolResult> {
    const service = typeof input.service === 'string' ? input.service : '';
    // A service's own entry, never a name every object inherits (toString).
    const baseOf = (map: Record<string, string>): string | undefined => (Object.hasOwn(map, service) ? map[service] : undefined);
    let services = await this.resolveServices();
    let base = baseOf(services);
    if (!base && service) {
      // A name we don't know yet is the likeliest moment for the directory to
      // have moved under us — a service that went live since our last refresh.
      // Re-ask once before refusing, so a new archipelago service is usable
      // immediately rather than after a cache expiry.
      services = await this.resolveServices({ force: true });
      base = baseOf(services);
    }
    if (!base) {
      // The layered directory always holds the built-in services, so the
      // list is never empty.
      const known = Object.keys(services).join(', ');
      return fail(service
        ? `Nothing was sent: there's no service "${service}" here. The services are ${known}.`
        : `Nothing was sent: identity--request needs \`service\`, the name of one of the services: ${known}.`);
    }
    if (typeof input.path !== 'string' || !input.path.startsWith('/')) {
      return fail(
        'Nothing was sent: `path` must be text starting with "/", the part of the address after the service\'s, ' +
        `such as "/api/ops"; it was ${shown(input.path)}.`,
      );
    }
    const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET';
    if (!(REQUEST_METHODS as readonly string[]).includes(method)) {
      return fail(
        `Nothing was sent: method "${method}" isn't one this utility sends. Use ${REQUEST_METHODS.slice(0, -1).join(', ')} ` +
        `or ${REQUEST_METHODS[REQUEST_METHODS.length - 1]}.`,
      );
    }
    // A body or an upload with GET would be dropped while the call reports
    // success, and `method` defaults to GET, so a write that forgot its verb
    // would silently read instead. Refuse it, naming the verbs that carry one.
    const carrying = REQUEST_METHODS.filter((m) => m !== 'GET').join(', ');
    const isGet = `the method is GET${typeof input.method === 'string' ? '' : ' by default'}`;
    if (method === 'GET' && input.body !== undefined) {
      return fail(
        `Nothing was sent: \`body\` needs a method that sends one (${carrying}), and ${isGet}. Pass one of those as ` +
        '`method`, or leave `body` out to read.',
      );
    }
    const workspace = this.ctx?.getModule<WorkspaceModule>('workspace');
    let bodyStr: string | undefined;
    if (input.body !== undefined) {
      bodyStr = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
      if (bodyStr.length > REQUEST_BODY_MAX) {
        return fail(
          `Nothing was sent: the body is ${bodyStr.length} characters, over the ${REQUEST_BODY_MAX}-character limit for \`body\`.` +
          (workspace
            ? ' To send more, write it to a workspace file and pass that file\'s path as `fromFile` instead, which takes up to 64 MiB.'
            : ''),
        );
      }
    }
    // saveAs writes the response to the workspace, so without one the
    // request isn't sent: a write would otherwise go out with its answer lost.
    const saveAs = typeof input.saveAs === 'string' && input.saveAs.length > 0 ? input.saveAs : undefined;
    if (saveAs !== undefined && !workspace) {
      return fail(
        'Nothing was sent: `saveAs` writes the response to the workspace, and this host has no workspace. Leave ' +
        '`saveAs` out to have a text response returned to you, or ask your operator to enable the workspace.',
      );
    }
    if (saveAs !== undefined && workspace) {
      const unkept = this.cannotKeep(workspace, saveAs);
      if (unkept) return fail(`Nothing was sent: ${unkept}`);
    }

    // Uploads: the agent names a workspace file, the host sends its bytes. The
    // mirror of saveAs — a file too big to write into a turn is exactly the
    // case that needs this, so the bytes never enter model context, and the
    // small JSON body cap does not apply to them.
    let upload: { bytes: Buffer; contentType: string; path: string; from: string } | undefined;
    if (typeof input.fromFile === 'string' && input.fromFile.length > 0) {
      if (bodyStr !== undefined) return fail('Nothing was sent: pass `body` or `fromFile`, not both.');
      if (method === 'GET') {
        return fail(`Nothing was sent: \`fromFile\` needs a method that sends a body (${carrying}), and ${isGet}. Pass one of those as \`method\`.`);
      }
      if (!workspace) {
        return fail(
          'Nothing was sent: `fromFile` reads a workspace file, and this host has no workspace, so it can\'t be used ' +
          'here. Send JSON content as `body` instead; a binary file can\'t be uploaded from this host.',
        );
      }
      const contentType = typeof input.contentType === 'string' && input.contentType
        ? input.contentType
        : guessContentType(input.fromFile);
      // fetch refuses a header value it can't send (a line break, a NUL, a
      // character past Latin-1) before it connects, which the catch below
      // would word as no reply. The runtime's own Headers refuses the same
      // values, so asking it first keeps the rule the runtime's.
      try {
        new Headers({ 'content-type': contentType });
      } catch {
        return fail(
          `Nothing was sent: \`contentType\` ${shown(input.contentType)} can't be sent as a header. Pass one such as ` +
          '"audio/mpeg", or leave it out to have it inferred from the file\'s extension.',
        );
      }
      const read = await this.readUpload(workspace, input.fromFile, service);
      if ('refusal' in read) return fail(read.refusal);
      upload = { bytes: read.bytes, contentType, path: input.fromFile, from: read.from };
    }

    let access: string;
    try {
      access = await this.accessFor(service); // service name == audience name
    } catch (err) {
      if (!(err instanceof IdentityError)) throw err;
      // The log gets the operator's sentence, which can name the host's files.
      console.error(`[identity] request to "${service}": ${err.message}`);
      return fail(`Nothing was sent to "${service}": ${sentence(err.forAgent)}`);
    }
    // Once the request may have gone out, a failure says which copy of a file
    // it carried when it was the workspace's, as every success does in `sent`.
    const copySent = upload && upload.from !== 'disk'
      ? ` The upload was the workspace's copy of "${upload.path}", since disk has no file at this path.`
      : '';
    const f = this.config.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${base}${input.path}`, {
        method,
        headers: {
          authorization: `Bearer ${access}`,
          ...(bodyStr !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(upload ? { 'content-type': upload.contentType } : {}),
        },
        ...(bodyStr !== undefined ? { body: bodyStr } : {}),
        // Uint8Array view, not the Buffer itself: Buffer is not a BodyInit.
        ...(upload ? { body: new Uint8Array(upload.bytes) } : {}),
      });
    } catch (err) {
      // No reply, so whether the request reached the service is unknown.
      return fail(
        `The request to "${service}" got no reply: ${sentence(errorText(err))} Whether it reached the service is ` +
        (method === 'GET' ? 'unknown; a GET only reads, so it can be sent again.' : `unknown, so check whether the ${method} took effect before sending it again.`) +
        copySent,
      );
    }
    // From here the service has answered, with this status: only reading or
    // keeping its response can fail, and anything the request changed stays
    // changed. The status says whether the service did what was asked.
    const answered = `The request to "${service}" was answered with status ${res.status}`;
    const changed = method === 'GET'
      ? ''
      : ` Anything the ${method} changed on the service stays changed, so check before sending it again.`;
    // A receipt for what left the house, so an upload is verifiable from the
    // turn that made it without re-reading the file, and says which copy of
    // the file went. Every success of an upload carries it.
    const sent = upload
      ? { sent: { path: upload.path, size: upload.bytes.byteLength, contentType: upload.contentType, from: upload.from } }
      : {};
    try {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength > RESPONSE_BODY_MAX) {
        return fail(`${answered}, but its response is ${bytes.byteLength} bytes, over the ${RESPONSE_BODY_MAX}-byte limit, so it wasn't kept.${copySent}${changed}`);
      }
      const declaredType = res.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() || '';
      const contentType = declaredType || 'application/octet-stream';
      const sha256 = createHash('sha256').update(bytes).digest('hex');

      if (saveAs !== undefined && workspace) {
        const written = await workspace.writeBinary(saveAs, bytes, contentType);
        // A file the workspace stored, with only its copy on disk failed, is
        // saved: the workspace's tools read it from the store. The receipt
        // says what disk lacks, as agent-framework's save_recent_image does.
        const stored = written.success || (written.data as { inChronicle?: boolean } | undefined)?.inChronicle === true;
        if (!stored) {
          return fail(`${answered}, but its response couldn't be saved to "${saveAs}": ${sentence(written.error ?? 'no reason given')}${copySent}${changed}`);
        }
        return ok({
          status: res.status,
          saved: {
            path: saveAs, size: bytes.byteLength, contentType, sha256,
            ...(written.success ? {} : { diskCopyError: written.error ?? 'its copy on disk failed' }),
          },
          ...sent,
        });
      }

      const text = bytes.toString('utf8');
      let parsed: unknown;
      let parsedJson = false;
      try {
        parsed = JSON.parse(text);
        parsedJson = true;
      } catch {
        /* not JSON */
      }
      const textual = declaredType.startsWith('text/')
        || declaredType === 'application/json'
        || declaredType.endsWith('+json')
        || declaredType === 'application/xml'
        || declaredType.endsWith('+xml')
        // Some tiny internal/fake services omit content-type on JSON. A full
        // successful parse is a safer fallback than treating valid JSON as
        // opaque bytes; arbitrary binary almost never parses as one JSON value.
        || (!declaredType && parsedJson);
      // An empty body (a 204, or an empty 200) is an empty success, not an
      // omitted binary: advising a repeat with saveAs would re-send a write.
      if (bytes.byteLength === 0) {
        return ok({ status: res.status, body: '', ...sent });
      }
      if (!textual) {
        return ok({
          status: res.status,
          body: null,
          binary: {
            size: bytes.byteLength, contentType, sha256,
            // Keeping it takes saveAs, which takes a workspace. Only a GET can
            // be sent again to fetch what it answered: any other method would
            // repeat what it did.
            note: !workspace
              ? 'Binary response omitted from text context, and not kept: keeping one takes `saveAs`, which needs a ' +
                'workspace, and this host has none. If you need it, your operator can enable the workspace.'
              : method === 'GET'
                ? 'Binary response omitted from text context; repeat the request with saveAs to write it byte-exactly to a workspace mount.'
                : `Binary response omitted from text context, and not kept: sending this ${method} again with \`saveAs\` would ` +
                  'repeat it. When you need a write\'s binary response, pass `saveAs` with the write itself.',
          },
          ...sent,
        });
      }

      let body: unknown = parsedJson ? parsed : text;
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      if (raw.length > RESPONSE_INLINE_MAX) {
        body = `${raw.slice(0, RESPONSE_INLINE_MAX)}… [truncated ${raw.length - RESPONSE_INLINE_MAX} chars]`;
      }
      return ok({ status: res.status, body, ...sent });
    } catch (err) {
      return fail(`${answered}, but its response couldn't be read or kept: ${sentence(errorText(err))}${copySent}${changed}`);
    }
  }

  /**
   * Why the workspace's write would refuse `path`, asked before the request
   * goes out, so a write never goes out with its answer refused for its
   * path: no mount has the path, it names a mount but no file, it has an
   * empty part right after the mount's name or a "." or ".." part, it leads
   * out of its mount, or its mount is read-only. Null when none holds. Each
   * refusal is one agent-framework 0.22.3's writeBinary makes too, after the
   * request has gone out: its path parser reads what follows an empty part
   * after the mount as absolute, which leads out of the mount unless it names
   * the mount's own directory, and its store refuses that tree path, as it
   * refuses an empty one or one with a "." or ".." part ("Invalid tree path"). The
   * check covers the path and the mount's mode. Whether the workspace is
   * running isn't public in 0.22.3, and a response over the mount's size
   * limit can only be known once it arrives.
   */
  private cannotKeep(workspace: WorkspaceModule, path: string): string | null {
    const mounts = workspace.getMounts();
    const writable = mounts.filter((m) => m.mode === 'read-write').map((m) => m.name);
    const remedy = writable.length > 0
      ? ` Pass \`saveAs\` a path in a mount it can write to (${writable.join(', ')}), as "<mount>/<file>", or leave it ` +
        'out to have a text response returned to you.'
      : ' The workspace has no mount it can write to, so leave `saveAs` out to have a text response returned to you.';
    const slash = path.indexOf('/');
    const name = slash < 0 ? path : path.slice(0, slash);
    const mount = mounts.find((m) => m.name === name);
    if (!mount) return `\`saveAs\` names no mount the workspace has: "${path}".${remedy}`;
    if (slash < 0 || slash === path.length - 1) return `\`saveAs\` names the mount "${name}" but no file in it.${remedy}`;
    if (path.slice(slash + 1).startsWith('/')) {
      return `\`saveAs\` "${path}" has an empty part right after the mount's name, which the workspace can't save to; name the file by its plain path, such as "${name}/out.json".${remedy}`;
    }
    if (path.slice(slash + 1).split('/').some((part) => part === '.' || part === '..')) {
      return `\`saveAs\` "${path}" has a "." or ".." in it, which the workspace can't save to; name the file by its plain path, such as "${name}/out.json".${remedy}`;
    }
    // A write target is the use resolveAbsolutePath's doc keeps it for: it
    // answers null for a path that leads out of its mount. After the checks
    // above, no path found on Linux reaches this (a leading empty part and a
    // ".." are refused first), so this isn't the containment check: it stays
    // as the guard for whatever else the resolver itself puts outside a
    // mount, on any platform.
    if (workspace.resolveAbsolutePath(path) === null) return `\`saveAs\` "${path}" leads out of the mount "${name}".${remedy}`;
    if (mount.mode === 'read-only') return `\`saveAs\` names the read-only mount "${name}", where nothing can be saved.${remedy}`;
    return null;
  }

  /**
   * The bytes `fromFile` names, for an upload. Disk first, store second. An
   * upload is egress: reading it through the append-only store would retain
   * every byte forever and refuse anything binary or over the mount's
   * maxFileSize, which is most media; disk has neither problem. The disk read
   * is readFileFromDisk, which keeps the mount's link policy and reads only
   * inside the mount (it checks the canonical path it opened), so an upload
   * sends only what the mount allows, and its errors name the mount-prefixed
   * path, never the host's. The store's copy stands in only where disk has no
   * file (diskHasNoFile), such as one the resident wrote through the workspace
   * and never materialized, one removed from disk after the workspace took it
   * in, or one whose mount's directory is gone. Any other
   * refusal (a link the mount refuses or one leading out of it, a directory,
   * a file disk can't read) stops the upload, since the store's copy can
   * differ from disk's: an upload never sends another file than the one the
   * agent named without saying so, and `from` says which copy went.
   */
  private async readUpload(
    workspace: WorkspaceModule,
    path: string,
    service: string,
  ): Promise<{ bytes: Buffer; from: string } | { refusal: string }> {
    const nothingSent = `Nothing was sent to "${service}":`;
    const overLimit = (size: number, whose: string): { refusal: string } => ({
      refusal: `${nothingSent} ${whose} is ${size} bytes, over the ${UPLOAD_BODY_MAX}-byte upload limit, which is fixed, ` +
        'so calling again won\'t change that: send a smaller file.',
    });
    let onDisk: WorkspaceReadError;
    try {
      const fromDisk = await workspace.readFileFromDisk(path, { maxBytes: UPLOAD_BODY_MAX });
      // A read cut at the cap is of a file over it.
      if (fromDisk.truncated) return overLimit(fromDisk.size, `"${path}"`);
      return { bytes: fromDisk.bytes, from: 'disk' };
    } catch (err) {
      if (!(err instanceof WorkspaceReadError)) throw err;
      onDisk = err;
    }
    // A path no mount holds, or one leading out of its mount, has no copy
    // anywhere. One in another mount's directory nested in it, or reached
    // through a link into one (`other_mount`, from
    // anima-research/agent-framework#460, and for a link from the release
    // with anima-research/agent-framework#468), is that mount's: the reason
    // names the mount and the path to use there, so the outer mount's
    // workspace isn't offered in its place.
    if (['unknown_mount', 'traversal', 'other_mount'].includes(onDisk.code)) {
      return { refusal: `${nothingSent} ${sentence(onDisk.message)}` };
    }
    const diskReason = sentence(`${onDisk.message}${onDisk.errno ? ` (${onDisk.errno})` : ''}`);
    if (!diskHasNoFile(onDisk)) {
      return {
        refusal: `${nothingSent} "${path}" couldn't be read from disk, and the workspace's copy wasn't sent in its ` +
          `place, since it can differ from disk's. On disk: ${diskReason} ${diskRemedy(onDisk)}`,
      };
    }
    const fromStore = await workspace.readBinary(path);
    if ('error' in fromStore) {
      // The same reason from both reads, such as a file neither holds, is said once.
      const reasons = onDisk.message === fromStore.error
        ? sentence(fromStore.error)
        : `On disk: ${diskReason} In the workspace: ${sentence(fromStore.error)}`;
      return { refusal: `${nothingSent} "${path}" couldn't be read. ${reasons}` };
    }
    if (fromStore.data.byteLength > UPLOAD_BODY_MAX) {
      return overLimit(fromStore.data.byteLength, `the workspace's copy of "${path}"`);
    }
    return { bytes: fromStore.data, from: 'the workspace, since disk has no file at this path' };
  }

  private async acceptInvite(input: { invite?: unknown; name?: unknown }): Promise<ToolResult> {
    if (typeof input.invite !== 'string' || typeof input.name !== 'string') {
      return fail(
        'Nothing was sent: identity--accept_invite needs both `invite`, the invitation code from your operator, ' +
        'and `name`, the name to register as, each as text.',
      );
    }
    // One registration at a time: a second call while one is under way
    // would be refused by the service, or register this host twice. The
    // first call's answer goes to that call, which a session switch leaves in
    // the stopped session, so the refusal says what status shows instead:
    // never the outcome itself, which status can't show when it's unknown.
    // The call ends within IDENTITY_TIMEOUT_MS, the limit its fetch is given,
    // the reply's body included.
    if (this.state.enrolling) {
      return fail(
        'Nothing was sent: a registration is already under way on this host, and its answer goes to the call that ' +
        `started it, which may be in an earlier session. It ends within ${IDENTITY_TIMEOUT_MS / 1000} seconds, and ` +
        'identity--status then shows this host\'s registration if it recorded or holds one. If it shows none, call ' +
        'identity--accept_invite again with the same code and name.',
      );
    }
    const existing = this.record();
    if (existing) {
      return fail(
        `Nothing changed: this host is already registered as "${existing.name}"${existing.sub ? ` (${existing.sub})` : ''}, ` +
        `and registration happens once. identity--status shows it.${this.state.held ? ` ${HELD_NOTE}` : ''}`,
      );
    }
    this.state.enrolling = true;
    try {
      return await this.enroll(input.invite, input.name);
    } finally {
      this.state.enrolling = false;
    }
  }

  /** Ask the identity service to register this host, and keep what it answers. */
  private async enroll(invite: string, name: string): Promise<ToolResult> {
    const home = this.config.home;
    const timestamp = new Date().toISOString();
    const { id, proof } = this.prove(`archipelago-enroll|v1|${home}|${invite}|${timestamp}`);
    // An answer that leaves unknown whether the service registered this host:
    // the log says how to record it by hand, should the service hold it.
    const unknownToOperator = (what: string): void => {
      console.error(
        `[identity] registering this host as ${JSON.stringify(name)} with ${home}: the service ${what}, so whether it registered ` +
          `this host is unknown; if it holds this registration, record it by hand. ${this.recordByHand(name, null, timestamp)}`,
      );
    };
    // No reply, or a fault on the service's side: the registration may have
    // gone through first (archipelago-home adds the principal and uses the
    // invite before the step that can still fail), and the host then has no
    // record of it. A retry with the same code and name is then refused for
    // its invite or its name, which /enroll checks before the key, so no one
    // refusal marks that case.
    const unknownOutcome = (what: string): ToolResult => {
      unknownToOperator(what);
      return fail(
        `The identity service at ${home} ${what}, so whether it registered this host is unknown. Call ` +
        'identity--accept_invite again shortly with the same code and name. If that\'s refused, the first call may ' +
        'have registered this host without this host recording it, so don\'t try another name: ask your operator to ' +
        'check whether the identity service holds this registration, and if it does, to record it on this host by hand.',
      );
    };
    let reply: { status: number; json: Record<string, unknown> };
    try {
      reply = await this.post('/enroll', { invite, id, name, timestamp, proof });
    } catch (err) {
      return unknownOutcome(`gave no reply (${errorText(err)})`);
    }
    const { status, json } = reply;
    if (status === 200) return this.registered(name, typeof json.sub === 'string' ? json.sub : null, timestamp);
    const error = String(json.error ?? 'no reason given');
    if (status >= 500) return unknownOutcome(`answered with a fault of its own (${status}: ${error})`);
    if (status === 429) {
      // The service's rate limit answers before it looks at the registration,
      // so this call registered nothing, whatever an earlier one did.
      return fail(
        `The identity service at ${home} couldn't take the registration just now (429: ${error}), so this call ` +
        'registered nothing. Try again shortly.',
      );
    }
    if (status === 400) {
      // A 400 comes before the service registers anything (a malformed
      // request, a name it doesn't take, a stale timestamp) or after it:
      // archipelago-home answers "no audience configured" once it has added
      // the principal and used the invite. The status can't tell which, so
      // the agent reads the reason, and the operator is asked to check.
      unknownToOperator(`answered with 400: ${error}`);
      return fail(
        `The identity service at ${home} answered the registration with 400: ${error}. A 400 can come after the ` +
        'service has registered this host, so whether this call did is unknown. If the reason is about the name, call ' +
        'identity--accept_invite again with another name. Otherwise ask your operator, giving them the reason, to check ' +
        'whether the service holds this registration, and if it does, to record it on this host by hand.',
      );
    }
    // Any other answer: archipelago-home's are 403s, each before it registers
    // anything (the invite, the proof, the name, the key). Worded as the
    // service's answer all the same, with its reason for the agent to read,
    // and logged with it, since a reason such as "key already enrolled" is
    // the operator's to act on. Both allow for an earlier call whose outcome
    // was unknown, which may have registered this host: an operator often
    // reads the log from its last line, and after such a call this refusal is
    // that line. The host keeps no note of earlier outcomes, so the log points
    // to that call's line for the record to write.
    console.error(
      `[identity] registering this host as ${JSON.stringify(name)} with ${home}: the service answered ${status}: ${error}. ` +
        'If an earlier call got no reply, a fault of the service\'s own, or a 400 not about the name, it may have ' +
        'registered this host: check the service, and if it holds this registration, record it by hand as that call\'s ' +
        'line says.',
    );
    return fail(
      `The identity service at ${home} answered the registration with ${status}: ${error}. If an earlier call got no ` +
      'reply, a fault of the service\'s own, or a 400 not about the name, that call may have registered this host, so ' +
      'don\'t try another name: ask your operator to check whether the service holds this registration. Otherwise, if ' +
      'it refused the name, call identity--accept_invite again with another; for anything else, ask your operator, ' +
      'giving them the reason.',
    );
  }

  /**
   * Keep a registration the identity service answered 200 for. The service
   * holds it from then on, so registering again would be refused. When this
   * host can't record it (the record can't be saved, or no id could be read
   * from the reply), it holds the registration in memory until the host
   * restarts, across session switches, so status and access work until
   * then, and the operator is asked to record it. A record they write is
   * what the host reads from then on (record).
   */
  private registered(name: string, sub: string | null, enrolledAt: string): ToolResult {
    const home = this.config.home;
    const holding =
      'This host holds the registration until it restarts, so identity--status and access work until then. Don\'t ' +
      'call identity--accept_invite again: the service already holds this registration.';
    if (sub === null) {
      console.error(
        `[identity] ${home} answered 200 to registering this host as ${JSON.stringify(name)}, but no id could be read from its ` +
          `reply, so it wasn't recorded. This host holds it in memory only until it restarts. ` +
          this.recordByHand(name, null, enrolledAt),
      );
      this.state.held = { sub, name, home, enrolledAt };
      return fail(
        `The identity service at ${home} answered that it registered this host as "${name}" (200), but no id could ` +
        `be read from its reply, so this host couldn't record it. ${holding} Ask your operator to record this registration ` +
        'on this host by hand, with the id the identity service holds for it, before the host restarts.',
      );
    }
    try {
      this.saveRecord({ sub, name, home, enrolledAt });
    } catch (err) {
      // The operator gets the whole error, path included, and what to write;
      // the agent, as for the key and the record's read, neither the error's
      // words nor its code, since it can't act on them.
      console.error(
        `[identity] ${home} registered ${sub}, but its record couldn't be saved to ${this.recordPath}: ` +
          `${sentence(errorText(err))} This host holds it in memory only until it restarts. ` +
          this.recordByHand(name, sub, enrolledAt),
      );
      this.state.held = { sub, name, home, enrolledAt };
      return fail(
        `The identity service at ${home} registered this host as "${name}" (${sub}), but this host couldn't record ` +
        `that. ${holding} Ask your operator to fix what stopped the write, which the host's log names, and to record ` +
        'this registration by hand, before the host restarts.',
      );
    }
    // The log says so too: after an unknown outcome, its last word was to
    // record the registration by hand, which this host has now done.
    console.error(
      `[identity] registered this host as ${JSON.stringify(name)} with ${home} (${sub}), recorded at ${this.recordPath}.`,
    );
    // Note what is NOT returned: the first token the home node minted. The
    // host fetches its own, fresh, per use — the agent never holds one.
    return ok({
      registeredAs: name,
      id: sub,
      recognizedBy: home,
      note: 'Done — the host now handles access for you automatically.',
    });
  }
}
