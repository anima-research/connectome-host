/** Private, bounded delivery state for NoticesModule. No checkpoint dependence,
 * no event bus, no timers polling health, no replay/retry worker. */
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homeBindingKey, validateNoticeHome, type NoticeHomeConfig } from '../notice-home-config.js';
import { SHUTDOWN_BUDGET_EXHAUSTED, ZulipHomeDelivery,
  type HomeBackend, type HomeOutcome } from './notice-home-zulip.js';

const MAX_RECORDS = 128;
const MAX_ACTIVE = 64;
const MAX_QUEUED = 64;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ATTESTATION = {
  verification: 'operator-attested/unverified',
  selfEchoReadiness: 'operator-attested-preflight/not-runtime-verified',
} as const;

// No producer-defined labels enter the journal or message. Unknown kinds
// still get distinct incident keys and can be cleared by the original kind.
const ALERT_KINDS = [
  'hard-down', 'quota-spent', 'auth-expired', 'auth-rejected', 'auth-login-required',
  'provider-hold', 'context-refusal', 'mcpl-down', 'quota-unreadable', 'auth-expiring',
  'credential-unsaved', 'refusal-offpath', 'context-maintenance-failed', 'compression-quarantine',
  'instructions-unavailable', 'refusal', 'context-reinit-failed', 'deferred-import',
  'discord-awareness-unresolved', 'presentation-legacy', 'provider-wait', 'recovery-sync',
  'store-held-long', 'store-held-lost', 'stream-cancel-failed', 'thinking-binding-loss',
  'unknown-alert-kind',
] as const;
type AlertKind = typeof ALERT_KINDS[number];
// AF 0.33 emits completed before reporting refusal and without a stop reason.
// It signals a successful turn, which closes these kinds as legacy episodes do
// (AF emits no source clear for them), but not that a main refusal has ended.
const COMPLETED_CLOSES = ['hard-down', 'refusal-offpath', 'context-maintenance-failed'] as const;
const TURN_END_CLOSES = [...COMPLETED_CLOSES, 'context-refusal', 'refusal'] as const;
const HOME_TRACES = ['ops:alert', 'inference:completed', 'inference:turn_ended', 'mcpl:server-reconnected', 'module:added'] as const;
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => values.some(v => v === value);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const incidentKey = (kind: string | null, subject: string | null) => digest(JSON.stringify([kind, subject]));
const time = (n: number) => Number.isFinite(n) && Math.abs(n) <= 8.64e15;
export function noticeHomeDirectory(dataDir: string, logicalAgent: string): string {
  return join(dataDir, 'notice-home', digest(logicalAgent));
}

export interface HomeRuntime {
  directory: string;
  instanceId: string;
  /** Internal test seam, not recipe/operator policy. */
  sendTimeoutMs?: number;
}

interface SourceRef { type: 'startup' | typeof HOME_TRACES[number]; timestamp: number | null }
interface Tracking { activeIncidentIds: string[]; forgottenActive: number }
interface ActiveIncident { key: string; id: string; kind: AlertKind }
interface HomeRecord {
  id: string;
  eventKey: string;
  lastEventKey: string;
  phase: 'incident' | 'recovery-observed' | 'status';
  incidentId: string | null;
  incidentKey: string | null;
  instanceId: string;
  kind: AlertKind | 'startup-observation' | 'status-change';
  tracking?: Tracking; // Only status records.
  forgotten?: true; // Only the last incident record of a capacity-forgotten identity.
  source: SourceRef;
  lastSource: SourceRef;
  observedAt: number;
  lastSeen: number;
  count: number;
  outcome: HomeOutcome;
}
interface HomeJournal {
  version: 3;
  bindingId: string;
  currentInstance: string;
  retention: { evicted: number; forgottenActive: number };
  records: HomeRecord[];
  active: ActiveIncident[];
  lastStatus: string | null;
}

const statusKey = (tracking: Tracking) => digest(JSON.stringify([tracking.activeIncidentIds, tracking.forgottenActive]));

const anchorsIncident = (r: HomeRecord, a: ActiveIncident): boolean =>
  r.incidentId === a.id && r.phase === 'incident' && r.kind === a.kind && r.incidentKey === a.key;
/** An existing journal that could not be archived must not be replaced. */
class JournalStuck extends Error {}

const missing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};
const statEntry = (path: Buffer) => lstat(path).catch(error => {
  if (!missing(error)) throw error;
  return null;
});

async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
}

export class NoticeHome {
  private readonly journal: HomeJournal;
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private disabled: string | null = null;
  private shutdownDeadline: number | null = null;
  private readonly sendTimeoutMs: number;
  private readonly bindingId: string;
  private readonly instanceId: string;
  private bound = false;
  private delivery: ZulipHomeDelivery | null = null;
  private dropped = 0;
  private overflowReported = false;
  private observationDeliveryFailed = false;

  constructor(private readonly binding: NoticeHomeConfig, private readonly runtime: HomeRuntime,
    private readonly now: () => number) {
    validateNoticeHome(binding);
    this.binding = Object.freeze({ ...binding });
    this.runtime = Object.freeze({ ...runtime });
    this.sendTimeoutMs = runtime.sendTimeoutMs ?? 5000;
    if (!runtime.directory || !runtime.instanceId || runtime.instanceId.length > 256 ||
        /[\x00-\x1f\x7f]/.test(runtime.instanceId)) throw new Error('notice home requires a host directory and current runtime instance identity');
    this.bindingId = digest(homeBindingKey(this.binding));
    this.instanceId = digest(runtime.instanceId);
    this.journal = { version: 3, bindingId: this.bindingId, currentInstance: this.instanceId,
      retention: { evicted: 0, forgottenActive: 0 }, records: [], active: [], lastStatus: null };
  }

  bind(backend: HomeBackend): void {
    if (this.bound) return;
    this.bound = true;
    this.delivery = new ZulipHomeDelivery(this.binding, backend, this.sendTimeoutMs);
    const at = this.now();
    this.enqueue(async () => {
      if (!time(at)) throw new Error('invalid host clock');
      await this.startJournal();
      await this.status({ type: 'startup', timestamp: at }, at);
    });
  }

  observe(event: Record<string, unknown>): void {
    if (!this.bound || this.shutdownDeadline !== null || this.disabled) return;
    const type = event.type;
    if (!oneOf(HOME_TRACES, type)) return;
    const subject = typeof event.agentName === 'string' && event.agentName ? event.agentName : null;
    const turnCloses = type === 'inference:completed' ? COMPLETED_CLOSES
      : type === 'inference:turn_ended' ? TURN_END_CLOSES : null;
    if (turnCloses && subject === null) return;
    const at = this.now();
    const source: SourceRef = { type, timestamp: typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : null };
    // Only fixed fields and digests enter the queue. The trace ID helps
    // identify replay, but it is not trusted as a publishable identifier.
    const traceId = typeof event.traceId === 'string' ? event.traceId : null;
    const sourceId = digest(JSON.stringify([source, traceId,
      source.timestamp === null && traceId === null ? randomUUID() : null]));
    const rawKind = typeof event.kind === 'string' && event.kind ? event.kind : null;
    const clear = rawKind?.endsWith('-clear') ?? false;
    const base = clear ? rawKind!.slice(0, -6) : rawKind;
    const kind = oneOf(ALERT_KINDS, base) ? base : 'unknown-alert-kind';
    const component = type === 'mcpl:server-reconnected' && typeof event.serverId === 'string' ? event.serverId
      : type === 'module:added' && typeof event.moduleName === 'string' && event.moduleName.startsWith('mcpl:') ? event.moduleName.slice(5) : null;
    if (type !== 'ops:alert' && !turnCloses && !component) return;
    const boundServerObserved = component === this.binding.serverId;
    const alertKey = type === 'ops:alert' ? incidentKey(base, subject) : null;
    const recoveries = turnCloses ? turnCloses.map(k => incidentKey(k, subject))
      : component ? [incidentKey('mcpl-down', component)] : [];
    this.enqueue(async () => {
      if (!time(at)) throw new Error('invalid host clock');
      this.observationDeliveryFailed = false;
      let reportStatus = false;
      if (alertKey !== null) reportStatus = await this.alert(kind, alertKey, clear, source, sourceId, at);
      else {
        for (const incident of [...this.journal.active]) {
          if (recoveries.includes(incident.key) &&
              await this.alert(incident.kind, incident.key, true, source, sourceId, at)) reportStatus = true;
        }
      }
      // Ordinary inference traces are not a status feed. A reconnect or
      // registration of the destination can report a previously unsent view.
      if (reportStatus || boundServerObserved) await this.status(source, at);
    });
  }

  state(): { disabled: string | null; deliveryHalted: boolean; queued: number; records: number; dropped: number } {
    return { disabled: this.disabled, deliveryHalted: this.disabled !== null, queued: this.queued, records: this.journal.records.length, dropped: this.dropped };
  }
  settled(): Promise<void> { return this.chain; }
  async stop(): Promise<void> {
    // Close admission, not the accepted queue. An in-flight send already has
    // a deadline no later than this one; every subsequent send shares the rest.
    this.shutdownDeadline ??= performance.now() + this.sendTimeoutMs;
    await this.chain;
  }

  private readonly remainingShutdownMs = () => (this.shutdownDeadline ?? Infinity) - performance.now();

  private fail(reason: string, error: unknown): void {
    const stuck = error instanceof JournalStuck;
    const cause = stuck ? error.cause : error;
    if (!this.disabled) console.error(`[notices:home] delivery disabled: ${reason}; journal=${join(this.runtime.directory, 'journal.json')}; ` +
      `cause=${cause instanceof Error ? cause.message : String(cause)}. ` +
      (stuck ? 'No old entries were overwritten: check the journal and archives before restarting. '
        : 'Preserve the journal; check permissions and disk. ') +
      'No fallback/replay. Agent core continues.');
    this.disabled ??= reason;
  }
  private enqueue(work: () => Promise<void>): void {
    if (this.shutdownDeadline !== null || this.disabled) return;
    if (this.queued >= MAX_QUEUED) {
      if (!this.overflowReported) {
        console.error(`[notices:home] queue full; dropping new observations while at capacity. journal=${join(this.runtime.directory, 'journal.json')}`);
      }
      this.overflowReported = true;
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + 1);
      return;
    }
    this.queued++;
    this.chain = this.chain.then(async () => {
      try {
        if (!this.disabled) await work();
      }
      catch (error) {
        this.fail(error instanceof JournalStuck ? 'journal-not-moved-aside; later observations are not retained'
          : 'journal-unavailable-or-full; later observations are not retained', error);
      }
      finally { if (--this.queued === 0) this.overflowReported = false; }
    });
  }

  private async startJournal(): Promise<void> {
    const dir = this.runtime.directory;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const d = await lstat(dir);
    if (!d.isDirectory() || d.isSymbolicLink() || (d.mode & 0o077)) throw new Error('private directory required');
    await this.moveAside(dir);
    await this.save();
  }

  /** Only move the two fixed entries. Neither lstat nor rename follows the
   * final component, so link text and target names never enter a path lookup. */
  private async moveAside(dir: string): Promise<void> {
    let moved = false;
    try {
      for (const name of ['journal.json', 'journal.next']) {
        const path = Buffer.from(join(dir, name));
        if (!await statEntry(path)) continue;
        let aside: Buffer;
        // One active host owns this private directory. Check even UUID names
        // so rename never replaces an archive already present.
        do {
          aside = Buffer.from(join(dir, `journal.archived-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`));
        } while (await statEntry(aside));
        await rename(path, aside);
        console.error(`[notices:home] journal moved aside: ${path} -> ${aside}`);
        await syncDirectory(dir);
        moved = true;
      }
    } catch (error) {
      throw new JournalStuck('journal entries could not be moved aside durably', { cause: error });
    }
    if (moved) console.error('[notices:home] starting a fresh journal. Host restart or session switch loses correlation with earlier incidents. No replay.');
  }

  /** Fixed two-file atomic replacement: <= 2 MiB each. No append-only growth,
   * fsync intent + rename + directory BEFORE entering the side-effect boundary. */
  private async save(): Promise<void> {
    this.compact(this.journal.records.at(-1)?.id);
    const body = JSON.stringify(this.journal);
    if (Buffer.byteLength(body) > MAX_FILE_BYTES) throw new Error('retention byte cap');
    const path = join(this.runtime.directory, 'journal.next');
    // Startup moved any old staging name aside. If it reappears, fail
    // exclusive creation rather than deleting or truncating it.
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('private regular temp file required');
      await file.writeFile(body); await file.sync();
    } finally { await file.close(); }
    await rename(path, join(this.runtime.directory, 'journal.json'));
    await syncDirectory(this.runtime.directory);
  }

  /** Report status when tracking changes or an earlier unsent incident first delivers. */
  private async alert(kind: AlertKind, key: string, clear: boolean, source: SourceRef, sourceId: string, at: number): Promise<boolean> {
    const eventKey = digest(JSON.stringify([sourceId, key, clear]));
    if (this.journal.records.some((r) => r.eventKey === eventKey || r.lastEventKey === eventKey)) return false;
    let active = this.journal.active.find((a) => a.key === key);
    const changed = clear ? !!active : !active;
    if (!clear && !active) {
      if (this.journal.active.length >= MAX_ACTIVE) {
        const forgotten = this.journal.active.shift()!;
        // Compaction evicts older rows first once the identity is untracked,
        // so the marker lives at least as long as its earlier incident rows.
        const anchor = [...this.journal.records].reverse().find(r => anchorsIncident(r, forgotten));
        if (!anchor) throw new Error('forgotten incident has no anchor');
        anchor.forgotten = true; // Forget tracking, never claim a recovery.
        const retention = this.journal.retention;
        retention.forgottenActive = Math.min(Number.MAX_SAFE_INTEGER, retention.forgottenActive + 1);
      }
      active = { key, id: randomUUID(), kind };
      this.journal.active.push(active);
    }
    if (!clear) {
      const prior = [...this.journal.records].reverse().find((r) => r.incidentId === active!.id && r.phase === 'incident' &&
        r.outcome.state !== 'not-dispatched');
      if (prior) {
        // Order by most recent observation so the repeat is the active anchor.
        // Keep its original identity and receipt; prose is not an identity.
        this.journal.records.splice(this.journal.records.indexOf(prior), 1);
        prior.count = Math.min(Number.MAX_SAFE_INTEGER, prior.count + 1);
        prior.lastSeen = at; prior.lastSource = source; prior.lastEventKey = eventKey;
        this.journal.records.push(prior);
        await this.save();
        return false;
      }
    } else if (active) this.journal.active = this.journal.active.filter((a) => a !== active);
    const sent = await this.publish({ phase: clear ? 'recovery-observed' : 'incident', incidentId: active?.id ?? null,
      incidentKey: key, kind, source, eventKey, at });
    return changed || (!clear && sent);
  }

  private async status(source: SourceRef, at: number): Promise<void> {
    const startup = source.type === 'startup';
    const tracking = { activeIncidentIds: this.journal.active.map(a => a.id), forgottenActive: this.journal.retention.forgottenActive };
    const key = statusKey(tracking);
    if (!startup && key === this.journal.lastStatus) return;
    await this.publish({ phase: 'status', incidentId: null, incidentKey: null, kind: startup ? 'startup-observation' : 'status-change',
      tracking, source, eventKey: digest(randomUUID()), at, statusKey: key });
  }

  private async publish(input: Pick<HomeRecord, 'phase' | 'incidentId' | 'incidentKey' | 'kind' | 'source' | 'eventKey' | 'tracking'> &
    { at: number; statusKey?: string }): Promise<boolean> {
    const { at, statusKey, ...observation } = input;
    const r: HomeRecord = { ...observation, id: randomUUID(), lastEventKey: input.eventKey, instanceId: this.instanceId,
      lastSource: input.source, observedAt: at, lastSeen: at, count: 1, outcome: { state: 'intent' } };
    this.journal.records.push(r);
    if (this.remainingShutdownMs() <= 0) {
      r.outcome = { state: 'not-dispatched', detail: SHUTDOWN_BUDGET_EXHAUSTED };
    } else if (this.observationDeliveryFailed) {
      r.outcome = { state: 'not-dispatched', detail: 'earlier-delivery-failed-for-this-observation' };
    } else {
      await this.save();
      const attachment = JSON.stringify({ ...ATTESTATION, record: r });
      const text = `[host service-home observation; ${ATTESTATION.verification}; self-echo ${ATTESTATION.selfEchoReadiness}]\n` +
        `${new Date(r.observedAt).toISOString()} ${r.phase}: ${r.kind}\n` +
        `event=${r.id}; incident=${r.incidentId ?? 'not applicable'}; count=${r.count}\n` +
        (r.tracking ? `Tracked incident IDs: ${r.tracking.activeIncidentIds.join(', ') || 'none'}\nForgotten: ${r.tracking.forgottenActive}\n` : '') +
        `Pre-dispatch record: ${r.id}.json. Repeats update the private journal, not this message.`;
      const topic = r.phase === 'status' ? this.binding.statusTopic : this.binding.incidentsTopic;
      r.outcome = await this.delivery!.send(r.id, topic, text, attachment, this.remainingShutdownMs);
    }
    if (r.outcome.state !== 'sent') {
      // Suppress only the rest of this observation (e.g. its derived status).
      // Future independent observations may dispatch; old records NEVER replay.
      this.observationDeliveryFailed = true;
      console.error(`[notices:home] record ${r.id}: ${r.outcome.state}; detail=${r.outcome.detail}; serverId=${this.binding.serverId}; journal=${join(this.runtime.directory, 'journal.json')}; no replay. Agent core continues.`);
    }
    // An uncertain status may be what Zulip shows, so no baseline is known.
    if (statusKey && r.outcome.state !== 'not-dispatched') this.journal.lastStatus = r.outcome.state === 'sent' ? statusKey : null;
    await this.save();
    return r.outcome.state === 'sent';
  }

  /** Oldest records leave the explicit <=128-record dedupe window.
   * Includes unknown outcomes: this is a finite diagnostic window, not an audit log. Keep the newest incident
   * record of every active identity (even if a later status/clear is terminal). */
  private compact(currentId?: string): void {
    while (this.journal.records.length > MAX_RECORDS) {
      const anchors = new Set(this.journal.active.map(a => [...this.journal.records].reverse()
        .find(r => anchorsIncident(r, a))?.id));
      const index = this.journal.records.findIndex(r =>
        r.id !== currentId && !anchors.has(r.id));
      if (index < 0) throw new Error('protected backlog full; no evidence discarded');
      this.journal.records.splice(index, 1);
      this.journal.retention.evicted = Math.min(Number.MAX_SAFE_INTEGER, this.journal.retention.evicted + 1);
    }
  }
}
