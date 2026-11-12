/** Private, bounded delivery state for NoticesModule. No checkpoint dependence,
 * no event bus, no timers polling health, no replay/retry worker. */
import { constants } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, lstat, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homeBindingKey, validateNoticeHome, type NoticeHomeConfig } from '../notice-home-config.js';
import { ZulipHomeDelivery, validHomeMessageIds, type HomeBackend, type HomeOutcome } from './notice-home-zulip.js';

const MAX_RECORDS = 128;
const MAX_ACTIVE = 64;
const MAX_QUEUED = 64;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC = 8192;
// completed also precedes refusal reporting and has no stop reason in AF 0.33.
// endTurn proves a main-turn success, NOT auxiliary refusal/CM repair.
const TURN_END_CLOSES = new Set(['hard-down', 'context-refusal', 'refusal']);
const STATUS_TRACES = new Set(['inference:started', 'inference:aborted', 'inference:failed', 'inference:waiting',
  'inference:exhausted', 'inference:completed', 'inference:turn_ended', 'mcpl:server-reconnected', 'module:added', 'module:removed']);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const id = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9-]{36}$/.test(s);
const hash = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const smallString = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256;
const sourceRef = (s: SourceRef): boolean => !!s && smallString(s.type) &&
  (s.timestamp === null || Number.isFinite(s.timestamp)) && (s.traceId === null || typeof s.traceId === 'string' && s.traceId.length <= 256);

export function noticeHomeDirectory(dataDir: string, logicalAgent: string): string {
  return join(dataDir, 'notice-home', digest(logicalAgent));
}

export interface HomeRuntime {
  directory: string;
  instanceId: string;
  /** Internal test seam, not recipe/operator policy. */
  sendTimeoutMs?: number;
}

interface SourceRef { type: string; timestamp: number | null; traceId: string | null }
interface ActiveIncident { key: string; id: string; kind: string; subject: string }
interface HomeRecord {
  id: string;
  eventKey: string;
  lastEventKey: string;
  phase: 'incident' | 'recovery-observed' | 'status';
  incidentId: string | null;
  instanceId: string;
  topic: string;
  kind: string;
  subject: string;
  diagnostic: string;
  diagnosticCapped: boolean;
  metadata?: DiagnosticMetadata; // Absent on original v1 message-only records.
  source: SourceRef;
  lastSource: SourceRef;
  observedAt: number;
  lastSeen: number;
  count: number;
  outcome: HomeOutcome | { state: 'intent' };
}
interface HomeJournal {
  version: 1;
  binding: NoticeHomeConfig;
  verification: 'operator-attested/unverified';
  selfEchoReadiness: 'operator-attested-preflight/not-runtime-verified';
  currentInstance: string;
  deliveryHalted: boolean; // Legacy evidence only; never gates unrelated records.
  retention?: { evicted: number };
  records: HomeRecord[];
  active: ActiveIncident[];
  lastStatus: string | null;
}

/** Public diagnostic text only, never arbitrary data, request/response
 * objects, conversation bodies, stack, credentials, headers, env or reasoning.
 * Scrub recognizable secret/header assignments as an additional precaution;
 * this is not a universal secret detector or a new body-capture facility. */
function diagnostic(value: unknown): { text: string; capped: boolean } {
  const raw = typeof value === 'string' ? value : '(diagnostic unavailable)';
  const text = raw.slice(0, MAX_DIAGNOSTIC)
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, '$1: [REDACTED]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/\b(?:sk-|sk-ant-)[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
  return { text, capped: raw.length > MAX_DIAGNOSTIC };
}

interface DiagnosticMetadata {
  fields: Record<string, unknown>;
  disposition: 'allowlisted-diagnostic-projection';
  omitted: number;
  truncated: boolean;
  redacted: boolean;
}

/** AF boundFailureFields bounds JSON; it does NOT guarantee privacy. Only
 * known operational scalars/counters cross this boundary, never arbitrary
 * nested data. Unknown fields counted, not named (keys can themselves leak). */
function safeMetadata(value: unknown): DiagnosticMetadata {
  const fields: Record<string, unknown> = {};
  let omitted = 0, truncated = false, redacted = false;
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(v));
  const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const text = (v: string, max: number) => {
    const d = diagnostic(v); redacted ||= d.text !== v.slice(0, MAX_DIAGNOSTIC);
    truncated ||= d.capped || d.text.length > max;
    return d.text.length > max ? d.text.slice(0, max - 20) + '[metadata truncated]' : d.text;
  };
  const counters = new Set(['count', 'mail', 'keptForRecovery', 'heldBySurgery', 'passedOn', 'streak']);
  const progressCounters = new Set(['totalChunks', 'chunksCompressed', 'l1QueueLength', 'l1WaitingOnTools',
    'mergeQueueLength', 'mergesWaitingOnTools']);
  if (!plain(value)) { if (value !== undefined) omitted++; }
  else for (const [key, v] of Object.entries(value)) {
    if ((counters.has(key) && count(v)) || (key === 'agentEnded' && typeof v === 'boolean')) fields[key] = v;
    else if (['category', 'scope', 'pending'].includes(key) && typeof v === 'string') fields[key] = text(v, 512);
    else if (key === 'kinds' && plain(v)) {
      const kinds: Record<string, number> = Object.create(null);
      for (const [k, n] of Object.entries(v)) {
        if (!count(n)) { omitted++; continue; }
        if (Object.keys(kinds).length >= 16) { omitted++; truncated = true; continue; }
        const name = text(k, 128);
        if (Object.hasOwn(kinds, name)) { omitted++; continue; }
        kinds[name] = n as number;
      }
      fields.kinds = kinds;
    } else if (key === 'progress' && plain(v)) {
      const progress: Record<string, unknown> = {};
      for (const [k, n] of Object.entries(v)) {
        if ((progressCounters.has(k) && count(n)) || (k === 'pending' && typeof n === 'boolean')) progress[k] = n;
        else if (k === 'summaryCounts' && plain(n)) {
          const summaries: Record<string, unknown> = {};
          for (const [level, total] of Object.entries(n)) {
            if (['l1', 'l2', 'l3'].includes(level) && count(total)) summaries[level] = total;
            else omitted++;
          }
          progress.summaryCounts = summaries;
        } else omitted++;
      }
      fields.progress = progress;
    } else omitted++;
  }
  while (JSON.stringify(fields).length > 3072) {
    delete fields[Object.keys(fields).at(-1)!]; omitted++; truncated = true;
  }
  return { fields, disposition: 'allowlisted-diagnostic-projection', omitted, truncated, redacted };
}

function validMetadata(m: DiagnosticMetadata): boolean {
  return !!m && Object.keys(m).sort().join(',') === 'disposition,fields,omitted,redacted,truncated' &&
    m.disposition === 'allowlisted-diagnostic-projection' && Number.isSafeInteger(m.omitted) && m.omitted >= 0 &&
    typeof m.truncated === 'boolean' && typeof m.redacted === 'boolean' && JSON.stringify(m).length <= 4096 &&
    JSON.stringify(safeMetadata(m.fields).fields) === JSON.stringify(m.fields);
}

/** Deliberately small health projection: no gate reasons, pending request
 * payloads, active stream bodies, provider errors or arbitrary nested data. */
function healthObservation(read: () => Record<string, unknown>, agentName: string): Record<string, unknown> {
  try {
    const h = read();
    const agent = Array.isArray(h.agents) ? h.agents.find((a) => a && a.name === agentName) : undefined;
    if (!agent || typeof agent.status !== 'string') return { knowledge: 'unknown', reason: 'agent-health-unavailable' };
    const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
    const p = agent.providerAdmission;
    const b = (v: unknown) => typeof v === 'boolean' ? v : null;
    return {
      knowledge: 'observed-not-continuous-health', agentStatus: agent.status.slice(0, 128),
      consecutiveInferenceFailures: n(agent.consecutiveInferenceFailures), refusalTotal: n(agent.refusalStats?.total),
      providerAdmissionSample: agent.status === 'idle' && p?.primaryActive === true ? 'transition-unsettled' : 'observed-at-record-time',
      providerAdmission: {
        // Trace callbacks can run before AF releases its admission gate.
        // idle+active is an unsettled sample, not a current active claim.
        primaryActive: agent.status === 'idle' && p?.primaryActive === true ? null : b(p?.primaryActive), primaryPending: b(p?.primaryPending), hostHold: b(p?.hostHold),
        auxiliaryInFlight: n(p?.auxiliaryInFlight), auxiliaryDeferred: n(p?.auxiliaryDeferred), heldRequests: n(p?.heldRequests),
      },
    };
  } catch { return { knowledge: 'unknown', reason: 'health-read-failed' }; }
}

export class NoticeHome {
  private journal: HomeJournal;
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private disabled: string | null = null;
  private stopped = false;
  private bound = false;
  private delivery: ZulipHomeDelivery | null = null;
  // Causal descendants (including callbacks after timeout) stay local without
  // permanently latching unrelated observations or waiting for a hung call.
  private readonly publicationContext = new AsyncLocalStorage<boolean>();
  private dispatching = false;
  private suppressDelivery = false;

  constructor(private readonly binding: NoticeHomeConfig, private readonly runtime: HomeRuntime,
    private readonly agentName: string, private readonly now: () => number) {
    validateNoticeHome(binding);
    this.binding = Object.freeze({ ...binding });
    this.runtime = Object.freeze({ ...runtime });
    if (!runtime.directory || !runtime.instanceId || runtime.instanceId.length > 256 ||
        /[\x00-\x1f\x7f]/.test(runtime.instanceId)) throw new Error('notice home requires a host directory and current runtime instance identity');
    this.journal = { version: 1, binding: { ...binding }, verification: 'operator-attested/unverified',
      selfEchoReadiness: 'operator-attested-preflight/not-runtime-verified', currentInstance: runtime.instanceId,
      deliveryHalted: false, records: [], active: [], lastStatus: null };
  }

  bind(backend: HomeBackend, readHealth: () => Record<string, unknown>): void {
    if (this.bound) return;
    this.bound = true;
    this.delivery = new ZulipHomeDelivery(this.binding, backend, this.runtime.sendTimeoutMs);
    const at = this.now();
    const observation = healthObservation(readHealth, this.agentName);
    this.enqueue(async () => {
      await this.load();
      this.suppressDelivery = false;
      await this.status(observation, at, true);
    });
  }

  observe(event: Record<string, unknown>, readHealth: () => Record<string, unknown>): void {
    if (!this.bound || this.stopped || this.disabled) return;
    const type = typeof event.type === 'string' ? event.type : '';
    if (type !== 'ops:alert' && !STATUS_TRACES.has(type)) return;
    if (type.startsWith('inference:') && event.agentName !== this.agentName) return;
    const at = this.now();
    const source: SourceRef = { type, timestamp: typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : null,
      traceId: typeof event.traceId === 'string' ? diagnostic(event.traceId).text.slice(0, 256) : null };
    // Copy bounded allowed fields NOW, not the raw trace into a deferred queue.
    const field = (value: string) => value.length <= 256 ? diagnostic(value).text : diagnostic(value).text.slice(0, 230) + '[field truncated at 256]';
    const kind = typeof event.kind === 'string' && event.kind ? field(event.kind) : 'unknown-alert-kind';
    const subject = typeof event.agentName === 'string' && event.agentName ? field(event.agentName) : '(source subject unknown)';
    const component = typeof event.serverId === 'string' ? field(event.serverId)
      : typeof event.moduleName === 'string' && event.moduleName.startsWith('mcpl:') ? field(event.moduleName.slice(5)) : null;
    const message = diagnostic(event.message);
    const metadata = safeMetadata(event.data);
    // AF emits some call failures synchronously while callTool is in flight.
    // Retain them locally, never recursively send their alerts OR statuses.
    const publicationRelated = this.publicationContext.getStore() === true;
    const observation = healthObservation(readHealth, this.agentName);
    this.enqueue(async () => {
      this.suppressDelivery = publicationRelated;
      if (type === 'ops:alert') await this.alert(kind, subject, message, source, at, metadata);
      else if (type === 'inference:turn_ended') {
        for (const incident of [...this.journal.active]) {
          if (incident.subject === this.agentName && TURN_END_CLOSES.has(incident.kind)) {
            await this.alert(`${incident.kind}-clear`, incident.subject,
              { text: `${type} observed; closes this source-defined episode, not proof of continuing health`, capped: false }, source, at);
          }
        }
      } else if ((type === 'mcpl:server-reconnected' || type === 'module:added') && component !== null) {
        if (this.journal.active.some((a) => a.kind === 'mcpl-down' && a.subject === component)) {
          await this.alert('mcpl-down-clear', component,
            { text: `${type} observed for this component; not proof of continuing availability`, capped: false }, source, at);
        }
      }
      await this.status(observation, at, false);
    });
  }

  state(): { disabled: string | null; deliveryHalted: boolean; legacyDeliveryHalted: boolean; queued: number; records: number } {
    return { disabled: this.disabled, deliveryHalted: this.disabled !== null, legacyDeliveryHalted: this.journal.deliveryHalted, queued: this.queued, records: this.journal.records.length };
  }
  settled(): Promise<void> { return this.chain; }
  async stop(): Promise<void> { this.stopped = true; await this.chain; }

  private fail(reason: string): void {
    if (!this.disabled) console.error(`[notices:home] delivery disabled: ${reason}; no fallback/replay. Agent core continues.`);
    this.disabled ??= reason;
  }
  private enqueue(work: () => Promise<void>): void {
    if (this.stopped || this.disabled) return;
    if (this.queued >= MAX_QUEUED) { this.fail('bounded-queue-exhausted; later observations are not retained'); return; }
    this.queued++;
    this.chain = this.chain.then(async () => {
      try { if (!this.stopped && !this.disabled) await work(); }
      catch { this.fail('journal-unavailable-corrupt-drifted-or-full; later observations are not retained'); }
      finally { this.queued--; }
    });
  }

  private async load(): Promise<void> {
    const dir = this.runtime.directory;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const d = await lstat(dir);
    if (!d.isDirectory() || d.isSymbolicLink() || (d.mode & 0o077)) throw new Error('private directory required');
    let handle;
    try { handle = await open(join(dir, 'journal.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (handle) {
      let j: HomeJournal;
      try {
        const s = await handle.stat();
        if (!s.isFile() || s.size > MAX_FILE_BYTES || (s.mode & 0o077)) throw new Error('private bounded file required');
        j = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
      validateNoticeHome(j.binding);
      if (j.version !== 1 || homeBindingKey(j.binding) !== homeBindingKey(this.binding) ||
          j.verification !== 'operator-attested/unverified' ||
          j.selfEchoReadiness !== 'operator-attested-preflight/not-runtime-verified' ||
          !smallString(j.currentInstance) || typeof j.deliveryHalted !== 'boolean' || !Array.isArray(j.records) || j.records.length > MAX_RECORDS ||
          !Array.isArray(j.active) || j.active.length > MAX_ACTIVE ||
          !(j.lastStatus === null || hash(j.lastStatus)) ||
          j.retention !== undefined && (!j.retention || !Number.isSafeInteger(j.retention.evicted) || j.retention.evicted < 0)) throw new Error('journal schema/binding mismatch');
      const ids = new Set<string>();
      for (const r of j.records) {
        if (!r || !id(r.id) || ids.has(r.id) || !smallString(r.instanceId) || typeof r.diagnostic !== 'string' ||
            !smallString(r.kind) || typeof r.subject !== 'string' || r.subject.length > 256 || typeof r.diagnosticCapped !== 'boolean' ||
            !(r.incidentId === null || id(r.incidentId)) || !sourceRef(r.source) || !sourceRef(r.lastSource) ||
            r.diagnostic.length > MAX_DIAGNOSTIC || !hash(r.eventKey) || !hash(r.lastEventKey) ||
            !Number.isSafeInteger(r.count) || r.count < 1 || !Number.isFinite(r.observedAt) || !Number.isFinite(r.lastSeen) ||
            !['status', 'incident', 'recovery-observed'].includes(r.phase) ||
            ![this.binding.statusTopic, this.binding.incidentsTopic].includes(r.topic) ||
            !['intent', 'sent', 'uncertain', 'not-dispatched'].includes(r.outcome?.state)) throw new Error('invalid record');
        if ((r.outcome.state === 'uncertain' || r.outcome.state === 'not-dispatched') && !smallString(r.outcome.detail)) throw new Error('invalid outcome');
        if (r.metadata !== undefined && !validMetadata(r.metadata)) throw new Error('invalid metadata');
        ids.add(r.id);
        if (r.topic !== (r.phase === 'status' ? this.binding.statusTopic : this.binding.incidentsTopic)) throw new Error('record topic drift');
        if (r.outcome.state === 'sent' && (!validHomeMessageIds(r.outcome.messageIds) ||
            r.outcome.serverId !== undefined && r.outcome.serverId !== this.binding.serverId ||
            r.outcome.messageIds.some(n => typeof n === 'string') && r.outcome.serverId !== this.binding.serverId)) throw new Error('invalid receipt');
        // A crash may follow dispatch, but precede the outcome write. Never replay.
        if (r.outcome.state === 'intent') {
          r.outcome = { state: 'uncertain', detail: 'restart-with-pending-intent; no replay' };
        }
      }
      const activeIds = new Set<string>();
      for (const a of j.active) {
        if (!a || typeof a.key !== 'string' || !id(a.id) || activeIds.has(a.id) || !smallString(a.kind) ||
            typeof a.subject !== 'string' || a.subject.length > 256 || a.key !== JSON.stringify([a.subject, a.kind]) ||
            !j.records.some((r) => r.incidentId === a.id && r.phase === 'incident')) throw new Error('invalid incident');
        activeIds.add(a.id);
      }
      this.journal = j;
    }
    this.journal.currentInstance = this.runtime.instanceId;
    // Preserve legacy deliveryHalted as historical evidence, not a global latch.
    this.journal.retention ??= { evicted: 0 };
    await this.save();
  }

  /** Fixed two-file atomic replacement: <= 2 MiB each. No append-only growth,
   * fsync intent + rename + directory BEFORE entering the side-effect boundary. */
  private async save(): Promise<void> {
    const body = JSON.stringify(this.journal);
    if (Buffer.byteLength(body) > MAX_FILE_BYTES) throw new Error('retention byte cap');
    const path = join(this.runtime.directory, 'journal.next');
    const file = await open(path, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('private regular temp file required');
      await file.writeFile(body); await file.sync();
    } finally { await file.close(); }
    await rename(path, join(this.runtime.directory, 'journal.json'));
    const dir = await open(this.runtime.directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await dir.sync(); } finally { await dir.close(); }
  }

  private async alert(kind: string, subject: string, message: { text: string; capped: boolean }, source: SourceRef, at: number, metadata?: DiagnosticMetadata): Promise<void> {
    const clear = kind.endsWith('-clear');
    const base = clear ? kind.slice(0, -6) : kind;
    const key = JSON.stringify([subject, base]);
    const identity: unknown[] = [source, kind, subject, message.text,
      source.timestamp === null && source.traceId === null ? at : null];
    if (metadata && Object.keys(metadata.fields).length) identity.push(metadata.fields);
    const eventKey = digest(JSON.stringify(identity));
    if (this.journal.records.some((r) => r.eventKey === eventKey || r.lastEventKey === eventKey)) return;
    let active = this.journal.active.find((a) => a.key === key);
    if (!clear && !active) {
      if (this.journal.active.length >= MAX_ACTIVE) throw new Error('active cap');
      active = { key, id: randomUUID(), kind: base, subject };
      this.journal.active.push(active);
    }
    if (!clear) {
      const prior = [...this.journal.records].reverse().find((r) => r.incidentId === active!.id && r.phase === 'incident' && r.outcome.state !== 'not-dispatched' && r.diagnostic === message.text && JSON.stringify(r.metadata?.fields ?? {}) === JSON.stringify(metadata?.fields ?? {}));
      if (prior) {
        prior.count = Math.min(Number.MAX_SAFE_INTEGER, prior.count + 1);
        prior.lastSeen = at; prior.lastSource = source; prior.lastEventKey = eventKey;
        await this.save();
        return;
      }
    } else if (active) this.journal.active = this.journal.active.filter((a) => a !== active);
    await this.publish({ phase: clear ? 'recovery-observed' : 'incident', incidentId: active?.id ?? null,
      kind, subject, diagnostic: message.text, diagnosticCapped: message.capped, metadata, source, eventKey, at });
  }

  private async status(observation: Record<string, unknown>, at: number, startup: boolean): Promise<void> {
    const snapshot = { ...observation, activeIncidents: this.journal.active.map(({ id, kind, subject }) => ({ id, kind, subject })) };
    const text = JSON.stringify(snapshot);
    const key = digest(text);
    if (!startup && key === this.journal.lastStatus) return;
    this.journal.lastStatus = key;
    await this.publish({ phase: 'status', incidentId: null, kind: startup ? 'startup-observation' : 'status-change',
      subject: this.agentName, diagnostic: text, diagnosticCapped: false,
      source: { type: 'healthSnapshot', timestamp: at, traceId: null },
      eventKey: digest(JSON.stringify([this.runtime.instanceId, at, key, startup])), at });
  }

  private async publish(input: { phase: HomeRecord['phase']; incidentId: string | null; kind: string; subject: string;
    diagnostic: string; diagnosticCapped: boolean; metadata?: DiagnosticMetadata; source: SourceRef; eventKey: string; at: number }): Promise<void> {
    this.compact();
    if (this.journal.records.length >= MAX_RECORDS || input.diagnostic.length > MAX_DIAGNOSTIC) throw new Error('protected-record retention cap');
    const r: HomeRecord = { id: randomUUID(), eventKey: input.eventKey, lastEventKey: input.eventKey,
      phase: input.phase, incidentId: input.incidentId, instanceId: this.runtime.instanceId,
      topic: input.phase === 'status' ? this.binding.statusTopic : this.binding.incidentsTopic,
      kind: input.kind, subject: input.subject, diagnostic: input.diagnostic, diagnosticCapped: input.diagnosticCapped, metadata: input.metadata,
      source: input.source, lastSource: input.source, observedAt: input.at, lastSeen: input.at, count: 1, outcome: { state: 'intent' } };
    this.journal.records.push(r);
    await this.save();
    const attachment = JSON.stringify({ binding: this.binding, verification: this.journal.verification,
      selfEchoReadiness: this.journal.selfEchoReadiness, record: r,
      scope: 'Allowlisted diagnostic projection, NOT full trace; arbitrary or unsafe structured fields omitted. Allowed observed diagnostic only; no inferred cause/offending message. Unknown source message/turn/checkpoint references. Attachment is the pre-dispatch record, not a delivery receipt.' }, null, 2);
    const text = `${new Date(r.observedAt).toISOString()} ${r.phase}: ${r.kind}\n` +
      `logicalAgent=${this.binding.logicalAgent}; instance=${r.instanceId}; sourceSubject=${r.subject}\n` +
      `verification=${this.journal.verification}; selfEcho=${this.journal.selfEchoReadiness}\n` +
      `event=${r.id}; incident=${r.incidentId ?? 'unknown/not applicable'}; count=${r.count}; lastSeen=${r.lastSeen}\n` +
      (r.diagnosticCapped ? `[RETENTION CAP: only first ${MAX_DIAGNOSTIC} input characters retained; excess not captured.]\n` : '') + r.diagnostic + (r.metadata ? `\nStructured diagnostic projection: ${JSON.stringify(r.metadata)}` : '');
    if (this.suppressDelivery) {
      r.outcome = { state: 'not-dispatched', detail: 'publication-related-observation; no recursive delivery' };
    } else {
      this.dispatching = true;
      try { r.outcome = await this.publicationContext.run(true, () => this.delivery!.send(r.id, r.topic, text, attachment)); }
      finally { this.dispatching = false; }
      if (r.outcome.state !== 'sent') {
        // Suppress only the rest of this observation (e.g. its derived status).
        // Future independent observations may dispatch; old records NEVER replay.
        this.suppressDelivery = true;
        console.error(`[notices:home] record ${r.id}: ${r.outcome.state}; no replay. Agent core continues.`);
      }
    }
    await this.save();
  }

  /** Oldest terminal records leave the explicit <=128-record dedupe window.
   * Unknown/pending outcomes never leave. Keep the newest incident record of
   * every active identity (even if a later status/clear is terminal). */
  private compact(): void {
    while (this.journal.records.length >= MAX_RECORDS) {
      const anchors = new Set(this.journal.active.map(a => [...this.journal.records].reverse()
        .find(r => r.incidentId === a.id && r.phase === 'incident')?.id));
      const index = this.journal.records.findIndex(r =>
        ['sent', 'not-dispatched'].includes(r.outcome.state) && !anchors.has(r.id));
      if (index < 0) throw new Error('protected backlog full; no evidence discarded');
      this.journal.records.splice(index, 1);
      this.journal.retention ??= { evicted: 0 };
      this.journal.retention.evicted = Math.min(Number.MAX_SAFE_INTEGER, this.journal.retention.evicted + 1);
    }
  }
}
