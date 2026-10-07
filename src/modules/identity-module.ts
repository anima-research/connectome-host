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
import { dirname } from 'node:path';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  createHash,
  type KeyObject,
} from 'node:crypto';
import type {
  Module,
  ModuleContext,
  ToolCall,
  ToolResult,
  ToolDefinition,
  WorkspaceModule,
} from '@animalabs/agent-framework';

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
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
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

function ok(data: unknown): ToolResult {
  return { success: true, data };
}
function fail(text: string): ToolResult {
  return { success: false, error: text, isError: true };
}

export class IdentityModule implements Module {
  readonly name = 'identity';
  private readonly recordPath: string;

  /** Last good service directory from the home node, and when we got it. */
  private servicesFromHome: Record<string, string> = {};
  private servicesFetchedAt = 0;
  private servicesInflight: Promise<void> | null = null;

  constructor(private readonly config: IdentityModuleConfig) {
    this.recordPath = config.keyPath.replace(/\.pem$/, '') + '.json';
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
            fromFile: { type: 'string', description: 'Workspace path whose raw bytes become the request body, e.g. files/music/track.mp3. Use instead of body for uploads; not combinable with it.' },
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
          'host handles access automatically (e.g. mcpl_deploy with an `access` name).',
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
          return await this.request(call.input as { service?: unknown; path?: unknown; method?: unknown; body?: unknown; saveAs?: unknown });
        default:
          return fail(`Unknown identity utility: ${call.name}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
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

  /** True once this deployment holds a registered principal. */
  isEnrolled(): boolean {
    return this.record() !== null;
  }

  /** The registered principal id (`agent:<name>@<domain>`), if any. */
  sub(): string | null {
    return this.record()?.sub ?? null;
  }

  /**
   * Exchange a key-proof for a fresh aid1 token for `audience`. Called per
   * MCPL dial (connect + every reconnect) and by HTTP helpers — which is
   * what lets audience tokens be short-lived. Throws with an actionable
   * message when unregistered or refused.
   */
  async accessFor(audience?: string): Promise<string> {
    const aud = audience ?? this.config.defaultAudience;
    if (!aud) throw new Error('identity: no audience named and none configured');
    if (!this.record()) {
      throw new Error(
        `identity: not registered with ${this.config.home} — the agent needs to accept an operator invite first (utils run identity--accept_invite)`,
      );
    }
    const key = this.loadOrCreateKey();
    const timestamp = new Date().toISOString();
    const statement = `archipelago-token|v1|${this.config.home}|${aud}|${timestamp}`;
    const proof = cryptoSign(null, Buffer.from(statement, 'utf8'), key.privateKey).toString('base64url');
    const { status, json } = await this.post('/token', { id: key.id, audience: aud, timestamp, proof });
    if (status !== 200 || typeof json.token !== 'string') {
      throw new Error(`identity: ${this.config.home} refused access to "${aud}" (${status}): ${String(json.error ?? 'unknown')}`);
    }
    return json.token;
  }

  /** Authorization header for HTTP calls to an audience's API. */
  async httpAuthFor(audience?: string): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.accessFor(audience)}` };
  }

  // ── key material ──

  private loadOrCreateKey(): { privateKey: KeyObject; id: string } {
    let privateKey: KeyObject;
    if (existsSync(this.config.keyPath)) {
      privateKey = createPrivateKey(readFileSync(this.config.keyPath, 'utf8'));
    } else {
      privateKey = generateKeyPairSync('ed25519').privateKey;
      mkdirSync(dirname(this.config.keyPath), { recursive: true });
      writeFileSync(this.config.keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    }
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
    return { privateKey, id: `ed25519:${spki.subarray(spki.length - 32).toString('base64url')}` };
  }

  private record(): IdentityRecord | null {
    try {
      return JSON.parse(readFileSync(this.recordPath, 'utf8')) as IdentityRecord;
    } catch {
      return null;
    }
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
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  // ── agent-facing utilities ──

  private status(): ToolResult {
    // Key material is deliberately created lazily here too, so `status` is
    // always safe to call — but none of it surfaces in the result.
    this.loadOrCreateKey();
    const rec = this.record();
    return ok(
      rec
        ? {
            registeredAs: rec.name,
            id: rec.sub,
            recognizedBy: rec.home,
            since: rec.enrolledAt,
            note: 'Access to services is handled by the host automatically (e.g. mcpl_deploy with an `access` name).',
          }
        : {
            registeredAs: null,
            note: `Not registered with ${this.config.home} yet — ask your operator for an invitation code, then use accept_invite.`,
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
   *  for the duration of one fetch, outside model context. */
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
    let services = await this.resolveServices();
    let base = services[service];
    if (!base && service) {
      // A name we don't know yet is the likeliest moment for the directory to
      // have moved under us — a service that went live since our last refresh.
      // Re-ask once before refusing, so a new archipelago service is usable
      // immediately rather than after a cache expiry.
      services = await this.resolveServices({ force: true });
      base = services[service];
    }
    if (!base) {
      return fail(`Unknown service "${service}". Available: ${Object.keys(services).join(', ')}`);
    }
    if (typeof input.path !== 'string' || !input.path.startsWith('/')) {
      return fail('`path` must be a string starting with "/"');
    }
    const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET';
    if (!(REQUEST_METHODS as readonly string[]).includes(method)) return fail(`unsupported method ${method}`);
    let bodyStr: string | undefined;
    if (input.body !== undefined && method !== 'GET') {
      bodyStr = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
      if (bodyStr.length > REQUEST_BODY_MAX) return fail(`body too large (${bodyStr.length} > ${REQUEST_BODY_MAX})`);
    }

    // Uploads: the agent names a workspace file, the host sends its bytes. The
    // mirror of saveAs — a file too big to write into a turn is exactly the
    // case that needs this, so the bytes never enter model context, and the
    // small JSON body cap does not apply to them.
    let upload: { bytes: Buffer; contentType: string; path: string } | undefined;
    if (typeof input.fromFile === 'string' && input.fromFile.length > 0) {
      if (bodyStr !== undefined) return fail('pass either `body` or `fromFile`, not both');
      if (method === 'GET') return fail('`fromFile` needs a method other than GET');
      const workspace = this.ctx?.getModule<WorkspaceModule>('workspace');
      if (!workspace) return fail('identity request: workspace module is not available for fromFile');
      // Disk first, store second. An upload is egress: reading it through the
      // append-only store would retain every byte forever and refuse anything
      // binary or over the mount's maxFileSize — which is most media. Disk
      // has neither problem. The store remains the fallback for a file the
      // resident wrote through the workspace and never materialized.
      const diskRead = (workspace as WorkspaceModule & {
        readBinaryFromDisk?: (
          path: string,
          opts?: { maxBytes?: number },
        ) => Promise<{ data: Buffer; absolutePath: string } | { error: string }>;
      }).readBinaryFromDisk;
      const fromDisk = diskRead
        ? await diskRead.call(workspace, input.fromFile, { maxBytes: UPLOAD_BODY_MAX })
        : { error: 'this host has no disk read path' };
      let bytes: Buffer;
      if (!('error' in fromDisk)) {
        bytes = fromDisk.data;
      } else {
        const fromStore = await workspace.readBinary(input.fromFile);
        if ('error' in fromStore) {
          return fail(
            `identity request: could not read ${input.fromFile}: ${fromDisk.error}; ${fromStore.error}`,
          );
        }
        bytes = fromStore.data;
      }
      if (bytes.byteLength > UPLOAD_BODY_MAX) {
        return fail(`file too large (${bytes.byteLength} > ${UPLOAD_BODY_MAX})`);
      }
      upload = {
        bytes,
        contentType:
          typeof input.contentType === 'string' && input.contentType
            ? input.contentType
            : guessContentType(input.fromFile),
        path: input.fromFile,
      };
    }

    let access: string;
    try {
      access = await this.accessFor(service); // service name == audience name
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const f = this.config.fetchImpl ?? fetch;
    try {
      const res = await f(`${base}${input.path}`, {
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
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength > RESPONSE_BODY_MAX) {
        return fail(`response too large (${bytes.byteLength} > ${RESPONSE_BODY_MAX})`);
      }
      const declaredType = res.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() || '';
      const contentType = declaredType || 'application/octet-stream';
      const sha256 = createHash('sha256').update(bytes).digest('hex');

      if (typeof input.saveAs === 'string' && input.saveAs.length > 0) {
        const workspace = this.ctx?.getModule<WorkspaceModule>('workspace');
        if (!workspace) return fail('identity request: workspace module is not available for saveAs');
        const written = await workspace.writeBinary(input.saveAs, bytes, contentType);
        if (!written.success) return fail(`identity request: could not save response: ${written.error ?? 'unknown'}`);
        return ok({
          status: res.status,
          saved: { path: input.saveAs, size: bytes.byteLength, contentType, sha256 },
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
      if (!textual) {
        return ok({
          status: res.status,
          body: null,
          binary: {
            size: bytes.byteLength, contentType, sha256,
            note: 'Binary response omitted from text context; repeat the request with saveAs to write it byte-exactly to a workspace mount.',
          },
        });
      }

      let body: unknown = parsedJson ? parsed : text;
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      if (raw.length > RESPONSE_INLINE_MAX) {
        body = `${raw.slice(0, RESPONSE_INLINE_MAX)}… [truncated ${raw.length - RESPONSE_INLINE_MAX} chars]`;
      }
      return ok({
        status: res.status,
        body,
        // A receipt for what left the house, so an upload is verifiable from
        // the turn that made it without re-reading the file.
        ...(upload
          ? { sent: { path: upload.path, size: upload.bytes.byteLength, contentType: upload.contentType } }
          : {}),
      });
    } catch (err) {
      return fail(`${service} request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async acceptInvite(input: { invite?: unknown; name?: unknown }): Promise<ToolResult> {
    if (typeof input.invite !== 'string' || typeof input.name !== 'string') {
      return fail('accept_invite needs { invite, name }');
    }
    const existing = this.record();
    if (existing) {
      return fail(`Already registered as "${existing.name}" (${existing.sub}) — registration is one-time.`);
    }
    const key = this.loadOrCreateKey();
    const timestamp = new Date().toISOString();
    const statement = `archipelago-enroll|v1|${this.config.home}|${input.invite}|${timestamp}`;
    const proof = cryptoSign(null, Buffer.from(statement, 'utf8'), key.privateKey).toString('base64url');
    const { status, json } = await this.post('/enroll', {
      invite: input.invite,
      id: key.id,
      name: input.name,
      timestamp,
      proof,
    });
    if (status !== 200 || typeof json.sub !== 'string') {
      return fail(`Registration refused (${status}): ${String(json.error ?? 'unknown')}`);
    }
    this.saveRecord({ sub: json.sub, name: input.name, home: this.config.home, enrolledAt: timestamp });
    // Note what is NOT returned: the first token the home node minted. The
    // host fetches its own, fresh, per use — the agent never holds one.
    return ok({
      registeredAs: input.name,
      id: json.sub,
      recognizedBy: this.config.home,
      note: 'Done — the host now handles access for you automatically.',
    });
  }
}
