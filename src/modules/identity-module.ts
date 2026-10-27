/**
 * The wire statements follow archipelago-home's src/statements.ts.
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

/** agent-framework's disk read reports a file disk lacks as not_found with
 *  ENOENT (nothing there, or a link that leads nowhere), ENOTDIR (a parent
 *  that's a file) or ENAMETOOLONG, and a mount whose directory is gone, or
 *  has a file in its place, as mount_unavailable with ENOENT or ENOTDIR.
 *  mount_unavailable with another errno, or none, is a root it couldn't
 *  resolve or trust. */
function diskHasNoFile(error: WorkspaceReadError): boolean {
  const gone = ['ENOENT', 'ENOTDIR'];
  if (error.code === 'mount_unavailable') return gone.includes(error.errno ?? '');
  return error.code === 'not_found' && [...gone, 'ENAMETOOLONG'].includes(error.errno ?? '');
}

function diskRemedy(error: WorkspaceReadError): string {
  switch (error.code as string) {
    case 'directory':
      return 'Name a file, not a directory.';
    case 'symlink':
      return 'It\'s a link, and this mount doesn\'t follow links. If you know it points to a file in the workspace, name ' +
        'that file by its own path; otherwise an upload can\'t send it, though your operator can put the file in the workspace.';
    case 'escape':
      return 'It leads, through a link, outside this mount, and an upload sends only a file that lies inside the mount ' +
        'it\'s named through. If you know the file lies in another mount, name it by its path there; otherwise your ' +
        'operator can put it in the workspace.';
    case 'parent_symlink':
      return 'A directory on its path is a link, and this mount doesn\'t follow links. If the link leads to a ' +
        'directory, which the reason shows by saying the mount\'s host can set followSymlinks, name the file by its ' +
        'path there. Otherwise ask your operator, giving them this reason.';
    case 'changed':
      return 'It changed while it was being read, and calling again reads it afresh.';
    default:
      return 'Disk refused the read, which is the host\'s to fix: ask your operator, giving them this reason.';
  }
}

export class IdentityError extends Error {
  constructor(message: string, readonly forAgent: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

export interface IdentityModuleConfig {
  keyPath: string;
  home: string;
  defaultAudience?: string;
  services?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

const DEFAULT_SERVICES: Record<string, string> = {
  orrery: 'https://orrery.animalabs.ai',
  eidoverse: 'https://eidoverse.animalabs.ai',
};

const SERVICES_TTL_MS = 60_000;
const SERVICES_TIMEOUT_MS = 5_000;
const IDENTITY_TIMEOUT_MS = 15_000;

const REQUEST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const REQUEST_BODY_MAX = 256 * 1024;
const UPLOAD_BODY_MAX = 64 * 1024 * 1024;

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
  return Object.hasOwn(CONTENT_TYPES, ext) ? CONTENT_TYPES[ext] : 'application/octet-stream';
}
const RESPONSE_INLINE_MAX = 24 * 1024;
const RESPONSE_BODY_MAX = 64 * 1024 * 1024;

interface IdentityRecord {
  sub: string;
  name: string;
  home: string;
  enrolledAt: string;
}

type HeldRegistration = Omit<IdentityRecord, 'sub'> & { sub: string | null };

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

const sentence = (text: string): string => `${text.trim().replace(/\.+$/, '')}.`;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const codeOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.name : 'a thrown value that isn\'t an error';
};

const transient = (status: number): boolean => status === 429 || status >= 500;

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

const IDENTITY_UNLOADED =
  'this host\'s identity couldn\'t be loaded. It\'s the host\'s to fix: ask your operator, who can find the reason in ' +
  'the host\'s log';

const HELD_NOTE =
  'This host holds this registration only until it restarts, since it couldn\'t record it. If your operator hasn\'t ' +
  'recorded it yet, ask them to, before the host restarts.';

export class IdentityModule implements Module {
  readonly name = 'identity';
  private readonly recordPath: string;

  private servicesFromHome: Record<string, string> = {};
  private servicesFetchedAt = 0;
  private servicesInflight: Promise<void> | null = null;

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
    return [];
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

  isEnrolled(): boolean {
    return this.record() !== null;
  }

  sub(): string | null {
    return this.record()?.sub ?? null;
  }

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

  async httpAuthFor(audience?: string): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.accessFor(audience)}` };
  }

  /** archipelago-home's /token finds a registration by its key, so a key made
   *  anew beside a registration gets no access. */
  private identityKey(): { privateKey: KeyObject; id: string } {
    if (!existsSync(this.config.keyPath)) {
      const rec = this.record();
      if (rec) {
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

  private keyFailure(err: unknown): IdentityError {
    return new IdentityError(
      `this host's identity key at ${this.config.keyPath} couldn't be read, made or used: ${errorText(err)}`,
      IDENTITY_UNLOADED,
    );
  }

  private prove(statement: string): { id: string; proof: string } {
    const key = this.identityKey();
    return { id: key.id, proof: cryptoSign(null, Buffer.from(statement, 'utf8'), key.privateKey).toString('base64url') };
  }

  private loadOrCreateKey(): { privateKey: KeyObject; id: string } {
    let privateKey: KeyObject;
    if (existsSync(this.config.keyPath)) {
      privateKey = createPrivateKey(readFileSync(this.config.keyPath, 'utf8'));
      // archipelago-home's ids and proofs are ed25519's.
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

  private unreadableRecord(detail: string): IdentityError {
    return new IdentityError(
      `this host's registration record ${this.recordPath} couldn't be read (${detail}), so whether this host is ` +
        'registered is unknown until it is fixed or restored',
      'this host\'s registration record couldn\'t be read, so whether this host is registered is unknown. It\'s the ' +
        'host\'s to fix: ask your operator, who can find the reason in the host\'s log',
    );
  }

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
    const parsed: unknown = await res.json().catch(() => null);
    const json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return { status: res.status, json };
  }

  private status(): ToolResult {
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
            registeredAs: null,
            note: `No registration with ${this.config.home} is recorded on this host. To register, ask your operator for an ` +
              'invitation code, then run identity--accept_invite through utils with it.',
          },
    );
  }

  private async resolveServices(opts: { force?: boolean } = {}): Promise<Record<string, string>> {
    const now = Date.now();
    const fresh = this.servicesFetchedAt > 0 && now - this.servicesFetchedAt < SERVICES_TTL_MS;
    if (!opts.force && fresh) return this.layerServices();
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
    const baseOf = (map: Record<string, string>): string | undefined => (Object.hasOwn(map, service) ? map[service] : undefined);
    let services = await this.resolveServices();
    let base = baseOf(services);
    if (!base && service) {
      services = await this.resolveServices({ force: true });
      base = baseOf(services);
    }
    if (!base) {
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
      // Headers refuses a value with a line break, a NUL or a character past
      // Latin-1, and so does fetch, before it connects.
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
      access = await this.accessFor(service);
    } catch (err) {
      if (!(err instanceof IdentityError)) throw err;
      console.error(`[identity] request to "${service}": ${err.message}`);
      return fail(`Nothing was sent to "${service}": ${sentence(err.forAgent)}`);
    }
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
        ...(upload ? { body: new Uint8Array(upload.bytes) } : {}),
      });
    } catch (err) {
      return fail(
        `The request to "${service}" got no reply: ${sentence(errorText(err))} Whether it reached the service is ` +
        (method === 'GET' ? 'unknown; a GET only reads, so it can be sent again.' : `unknown, so check whether the ${method} took effect before sending it again.`) +
        copySent,
      );
    }
    const answered = `The request to "${service}" was answered with status ${res.status}`;
    const changed = method === 'GET'
      ? ''
      : ` Anything the ${method} changed on the service stays changed, so check before sending it again.`;
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
        // agent-framework's writeBinary answers inChronicle: true for a file the
        // store took in whose later step failed, such as its copy on disk; the
        // workspace's tools read it from the store.
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
      }
      const textual = declaredType.startsWith('text/')
        || declaredType === 'application/json'
        || declaredType.endsWith('+json')
        || declaredType === 'application/xml'
        || declaredType.endsWith('+xml')
        || (!declaredType && parsedJson);
      if (bytes.byteLength === 0) {
        return ok({ status: res.status, body: '', ...sent });
      }
      if (!textual) {
        return ok({
          status: res.status,
          body: null,
          binary: {
            size: bytes.byteLength, contentType, sha256,
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

  private cannotKeep(workspace: WorkspaceModule, path: string): string | null {
    const mounts = workspace.getMounts();
    const writable = mounts.filter((m) => m.mode === 'read-write' && m.name !== '_config');
    const named = writable.map((m) => (m.include ? `"${m.name}" for ${m.include.join(' or ')}` : `"${m.name}"`)).join(', ');
    const remedy = writable.length > 0
      ? ` Pass \`saveAs\` a path in a mount it can write to (${named}), as "<mount>/<file>", or leave it ` +
        'out to have a text response returned to you.'
      : ' The workspace has no mount a response can be kept in, so leave `saveAs` out to have a text response returned to you.';
    const slash = path.indexOf('/');
    const name = slash < 0 ? path : path.slice(0, slash);
    const mount = mounts.find((m) => m.name === name);
    if (!mount) return `\`saveAs\` names no mount the workspace has: "${path}".${remedy}`;
    if (slash < 0 || slash === path.length - 1) return `\`saveAs\` names the mount "${name}" but no file in it.${remedy}`;
    if (name === '_config') return `\`saveAs\` names "_config", which holds the gate's config, where no response is kept.${remedy}`;
    if (path.slice(slash + 1).startsWith('/')) {
      return `\`saveAs\` "${path}" has an empty part right after the mount's name, which the workspace can't save to; name the file by its plain path.${remedy}`;
    }
    if (path.slice(slash + 1).split('/').some((part) => part === '.' || part === '..')) {
      return `\`saveAs\` "${path}" has a "." or ".." in it, which the workspace can't save to; name the file by its plain path.${remedy}`;
    }
    if (workspace.resolveAbsolutePath(path) === null) {
      return `\`saveAs\` "${path}" isn't a path the mount "${name}" holds: it leads out of the mount, lies in another mount's directory, falls outside its include, or can't name a file there.${remedy}`;
    }
    if (mount.mode === 'read-only') return `\`saveAs\` names the read-only mount "${name}", where nothing can be saved.${remedy}`;
    return null;
  }

  /** agent-framework's store keeps every byte read through it, and its mount's
   *  maxFileSize applies, so an upload reads disk first. */
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
      if (fromDisk.truncated) return overLimit(fromDisk.size, `"${path}"`);
      return { bytes: fromDisk.bytes, from: 'disk' };
    } catch (err) {
      if (!(err instanceof WorkspaceReadError)) throw err;
      onDisk = err;
    }
    // agent-framework's read reports a path in another mount's directory nested
    // in this one, or reached through a link into one, as other_mount, naming
    // that mount and the path to use there.
    if (['unknown_mount', 'traversal', 'outside_include', 'other_mount'].includes(onDisk.code)) {
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
    // A fetch's timeout signal bounds reading its reply's body too, so a
    // registration under way ends within IDENTITY_TIMEOUT_MS.
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

  private async enroll(invite: string, name: string): Promise<ToolResult> {
    const home = this.config.home;
    const timestamp = new Date().toISOString();
    const { id, proof } = this.prove(`archipelago-enroll|v1|${home}|${invite}|${timestamp}`);
    const unknownToOperator = (what: string): void => {
      console.error(
        `[identity] registering this host as ${JSON.stringify(name)} with ${home}: the service ${what}, so whether it registered ` +
          `this host is unknown; if it holds this registration, record it by hand. ${this.recordByHand(name, null, timestamp)}`,
      );
    };
    // archipelago-home adds the principal and uses the invite before a step
    // that can still fail, and checks the invite and the name before the key.
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
      // archipelago-home answers 400 before it registers anything (a malformed
      // request, a name it doesn't take, a stale timestamp) or after: "no audience
      // configured" comes once it has added the principal and used the invite.
      unknownToOperator(`answered with 400: ${error}`);
      return fail(
        `The identity service at ${home} answered the registration with 400: ${error}. A 400 can come after the ` +
        'service has registered this host, so whether this call did is unknown. If the reason is about the name, call ' +
        'identity--accept_invite again with another name. Otherwise ask your operator, giving them the reason, to check ' +
        'whether the service holds this registration, and if it does, to record it on this host by hand.',
      );
    }
    // archipelago-home's 403s each come before it registers anything (the
    // invite, the proof, the name, the key).
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

  /** archipelago-home holds a registration it answered 200 for, so registering
   *  again is refused. */
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
    console.error(
      `[identity] registered this host as ${JSON.stringify(name)} with ${home} (${sub}), recorded at ${this.recordPath}.`,
    );
    // archipelago-home's /enroll answers with a first token, which isn't passed
    // on.
    return ok({
      registeredAs: name,
      id: sub,
      recognizedBy: home,
      note: 'Done — the host now handles access for you automatically.',
    });
  }
}
