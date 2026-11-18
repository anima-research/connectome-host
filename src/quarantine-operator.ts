/** Local socket only. The native strategy remains the sole quarantine writer. */
import * as CM from '@animalabs/context-manager';
import type { CompressionQuarantineBinding, CompressionQuarantineReleaseResult } from '@animalabs/context-manager';
import { randomUUID } from 'node:crypto';
import { constants as F, openSync, closeSync, fstatSync, fsyncSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AppContext } from './index.js';
import { operatorWorkRunning } from './session-switch.js';

export type QuarantineCommand =
  | { type: 'quarantine-inspect'; agent: string; key?: string; limit?: number; corrId?: string }
  | { type: 'quarantine-release'; agent: string; key: string; generation: string; selection: string; operation: string; confirmation: string; corrId?: string }
  | { type: 'quarantine-result'; operation: string; corrId?: string };

const KEY = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TTL_MS = 60_000;
const MAX_SELECTIONS = 64;
const FORMAT = 'keyed-quarantine-v1';
const NATIVE_STATUSES = new Set(['released', 'stale', 'not-held', 'unsupported', 'unreadable', 'branchUnavailable', 'invalidSelection', 'uncertain']);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
type Reply = Record<string, unknown> & { status: string };
type Target = ReturnType<QuarantineOperator['target']>;
type Snapshot = {
  target: Target; expires: number; binding: CompressionQuarantineBinding;
  records: Map<string, string>; epoch: string;
  configuredAtInspection: { model: string | null; logicalProvider: string | null; credentialAlias: null };
};

/** A deliberate statement, not a boolean/actor-name authority claim. Shell agents can also supply it. */
export function waiverConfirmation(agent: string, key: string, generation: string, selection: string, operation: string): string {
  return `waive L1 hold ${agent} ${key} ${generation} ${selection} ${operation}`;
}

/** Anchored, append-only operation receipts, separate from the native store.
 * A reserved ID is NEVER dispatched again, even if its file is torn/empty.
 * Linux /proc directory-fd anchoring is required; elsewhere refuse, not weaken.
 */
class Receipts {
  private fd: number;
  constructor(dataDir: string) {
    if (process.platform !== 'linux') throw new Error('anchored receipts require Linux /proc/self/fd');
    const parent = openSync(dataDir, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
    try {
      const s = fstatSync(parent);
      if (s.uid !== process.getuid?.() || (s.mode & 0o022) !== 0) throw new Error('data directory ownership/write permissions refused');
      const path = `/proc/self/fd/${parent}/keyed-quarantine-operations`;
      try { mkdirSync(path, { mode: 0o700 }); fsyncSync(parent); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      this.fd = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
      try { this.check(this.fd, true); } catch (e) { closeSync(this.fd); throw e; }
    } finally { closeSync(parent); }
  }
  close(): void { closeSync(this.fd); }
  private check(fd: number, dir: boolean): void {
    const s = fstatSync(fd);
    if ((dir ? !s.isDirectory() : !s.isFile()) || s.uid !== process.getuid?.() ||
      (s.mode & 0o777) !== (dir ? 0o700 : 0o600) || (!dir && s.nlink !== 1)) {
      throw new Error('receipt ownership/mode/type/link count refused');
    }
  }
  private path(operation: string, suffix: string): string {
    if (!ID.test(operation)) throw new Error('invalid operation ID');
    return `/proc/self/fd/${this.fd}/${operation}.${suffix}.json`;
  }
  read(operation: string, suffix: string): unknown | undefined {
    let fd: number;
    try { fd = openSync(this.path(operation, suffix), F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
    try {
      this.check(fd, false);
      if (fstatSync(fd).size > 128_000) throw new Error('oversized receipt');
      return JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
  }
  write(operation: string, suffix: string, value: unknown): void {
    const fd = openSync(this.path(operation, suffix), F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
    try { this.check(fd, false); writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
    finally { closeSync(fd); }
    fsyncSync(this.fd);
  }
}

export class QuarantineOperator {
  private epoch = randomUUID();
  private selections = new Map<string, Snapshot>();
  private receipts: Receipts | undefined;
  constructor(private app: AppContext, private dataDir: string) {}
  /** Called on framework replacement, including an away-and-back session change. */
  invalidate(): void { this.epoch = randomUUID(); this.selections.clear(); }
  close(): void { this.invalidate(); this.receipts?.close(); this.receipts = undefined; }

  target(agentName: string) {
    const app = this.app;
    if (app.stopping || app.switching || operatorWorkRunning(app)) throw new Error('busy lifecycle');
    const framework = app.framework;
    const host = framework.getHostModeStatus();
    if (!host.drained || host.activeTurnAgents.length || host.parkedAdmissions || host.gatedRequests ||
      host.backgroundScripts || framework.getQueueDepth() || framework.getAllAgents().some(a => a.state.status !== 'idle')) {
      throw new Error('busy lifecycle');
    }
    if (typeof agentName !== 'string' || agentName.length === 0 || agentName.length > 200) throw new Error('invalid agent');
    const agent = framework.getAgent(agentName); // never default to another agent
    if (!agent) throw new Error('agent unavailable');
    const record = framework.getAgentRecord(agentName);
    if (!record || record.ended || !Number.isSafeInteger(record.incarnation)) throw new Error('agent lifecycle unavailable');
    const manager = agent.getContextManager();
    // A second physical CM copy is not the package against which this host is qualified.
    if (!(manager instanceof CM.ContextManager)) throw new Error('unsupported CM package identity');
    if (manager.isClosed()) throw new Error('manager unloaded');
    const strategy = manager.getStrategy();
    if (!('isKeyedCompressionQuarantineStrategy' in CM) || typeof CM.isKeyedCompressionQuarantineStrategy !== 'function' ||
      !CM.isKeyedCompressionQuarantineStrategy(strategy)) throw new Error('unsupported keyed capability');
    if (typeof record.namespace !== 'string' || framework.getAllAgents().some(other => other !== agent &&
      (other.getContextManager() === manager || other.getContextManager().getStrategy() === strategy))) {
      throw new Error('unsupported shared or unverifiable manager scope');
    }
    return { framework, agent, manager, strategy, incarnation: record.incarnation, namespace: record.namespace };
  }

  private journal(): Receipts { return this.receipts ??= new Receipts(this.dataDir); }
  private prior(operation: string): Reply | undefined {
    try {
      const intent = this.journal().read(operation, 'intent');
      if (intent === undefined) return undefined;
      const result = this.journal().read(operation, 'result');
      // Do not infer success from current key absence, or trust a malformed receipt.
      if (object(intent) && intent.format === FORMAT && intent.operation === operation &&
        typeof intent.key === 'string' && KEY.test(intent.key) && typeof intent.expectedGeneration === 'string' && intent.expectedGeneration &&
        object(intent.expectedBinding) && typeof intent.expectedBinding.namespace === 'string' &&
        typeof intent.expectedBinding.branch === 'string' && typeof intent.expectedBinding.loadId === 'string' &&
        object(result) && result.format === FORMAT && result.operation === operation && typeof result.status === 'string' &&
        NATIVE_STATUSES.has(result.status) && (result.status !== 'released' ||
          (result.key === intent.key && result.generation === intent.expectedGeneration &&
            Number.isSafeInteger(result.remainingRecords) && Number(result.remainingRecords) >= 0))) {
        return { status: 'recorded', operation, observed: result };
      }
      return { status: 'uncertain', operation, reason: 'reserved operation without a readable outcome; never redispatch' };
    } catch {
      // Includes torn intent, symlinks and unknown durability. Never dispatch past it.
      return { status: 'uncertain', operation, reason: 'receipt unavailable; no dispatch permitted' };
    }
  }

  async handle(command: QuarantineCommand): Promise<Reply> {
    const cmd = { ...command }; // Keep the operation/confirmation fixed across the native await.
    try {
      if (cmd.type === 'quarantine-result') {
        if (typeof cmd.operation !== 'string' || !ID.test(cmd.operation)) return { status: 'invalidSelection' };
        return this.prior(cmd.operation) ?? { status: 'unknown-operation', operation: cmd.operation };
      }
      if (cmd.type === 'quarantine-inspect') {
        if ((cmd.key !== undefined && (typeof cmd.key !== 'string' || !KEY.test(cmd.key))) ||
          (cmd.limit !== undefined && (!Number.isInteger(cmd.limit) || cmd.limit < 1 || cmd.limit > 100))) return { status: 'invalidSelection' };
        const target = this.target(cmd.agent);
        const view = target.strategy.inspectCompressionRefusalQuarantine({ key: cmd.key, limit: cmd.limit });
        if (view.status !== 'ok') return view;
        if (view.binding.namespace !== target.namespace || view.binding.branch !== target.manager.currentBranch().name) {
          return { status: 'refused', reason: 'loaded strategy scope does not match selected agent manager' };
        }
        const now = performance.now(); // elapsed-time expiry, unaffected by wall-clock rollback
        for (const [id, s] of this.selections) if (s.expires <= now) this.selections.delete(id);
        if (this.selections.size >= MAX_SELECTIONS) return { status: 'busy', reason: 'selection capacity; wait for expiry' };
        const selection = randomUUID();
        // Public configuration labels only, never actual upstream/credential observations.
        const configuredAtInspection = { model: view.configuredModel,
          logicalProvider: this.app.recipe.agent.provider ?? null, credentialAlias: null };
        this.selections.set(selection, { target, epoch: this.epoch, expires: now + TTL_MS, binding: { ...view.binding },
          configuredAtInspection,
          records: new Map(view.records.filter(r => r.selectable && r.generation !== null && KEY.test(r.key)).map(r => [r.key, r.generation!])) });
        return { ...view, selection, configuredAtInspection, expires: Date.now() + TTL_MS, serverEpoch: this.epoch, agent: cmd.agent, agentIncarnation: target.incarnation,
          actualRetry: 'unknown: no native-key/generation-to-provider-attempt correlation available' };
      }
      if (cmd.type !== 'quarantine-release') return { status: 'invalidSelection' };
      if (typeof cmd.operation !== 'string' || !ID.test(cmd.operation)) return { status: 'invalidSelection' };
      const previous = this.prior(cmd.operation);
      if (previous) return previous; // across clients, process restart and lost ACK
      const snapshot = this.selections.get(cmd.selection);
      this.selections.delete(cmd.selection); // one use, even when confirmation is refused
      if (!snapshot || snapshot.expires <= performance.now() || snapshot.epoch !== this.epoch) return { status: 'stale' };
      if (typeof cmd.key !== 'string' || !KEY.test(cmd.key) || typeof cmd.generation !== 'string' ||
        snapshot.records.get(cmd.key) !== cmd.generation || cmd.agent !== snapshot.target.agent.name ||
        cmd.confirmation !== waiverConfirmation(cmd.agent, cmd.key, cmd.generation, cmd.selection, cmd.operation)) {
        return { status: 'invalidSelection' };
      }
      const target = this.target(cmd.agent);
      if (target.framework !== snapshot.target.framework || target.agent !== snapshot.target.agent ||
        target.manager !== snapshot.target.manager || target.strategy !== snapshot.target.strategy ||
        target.incarnation !== snapshot.target.incarnation || target.namespace !== snapshot.target.namespace) return { status: 'stale' };
      const intent = { format: FORMAT, operation: cmd.operation, agent: cmd.agent, key: cmd.key, expectedGeneration: cmd.generation,
        expectedBinding: snapshot.binding, serverEpoch: this.epoch, agentIncarnation: target.incarnation,
        configuredAtInspection: snapshot.configuredAtInspection, actualRetry: 'unknown',
        selection: cmd.selection, confirmedAt: Date.now() };
      // Synchronous, anchored noclobber + fsync BEFORE the single native invocation.
      // No awaits between lifecycle/identity checks, reservation, and dispatch.
      try { this.journal().write(cmd.operation, 'intent', intent); }
      catch { return { status: 'uncertain', operation: cmd.operation, reason: 'intent persistence failed; no dispatch' }; }
      let observed: Reply;
      try {
        const outcome: CompressionQuarantineReleaseResult = await target.strategy.releaseCompressionRefusalQuarantine({
          key: cmd.key, expectedGeneration: cmd.generation, expectedBinding: { ...snapshot.binding },
        });
        observed = { ...outcome, format: FORMAT, operation: cmd.operation,
          configuredAtInspection: snapshot.configuredAtInspection, actualRetry: 'unknown' };
      } catch {
        observed = { status: 'uncertain', format: FORMAT, operation: cmd.operation,
          configuredAtInspection: snapshot.configuredAtInspection, actualRetry: 'unknown',
          reason: 'native call threw; writes may have landed; never retry' };
      }
      try { this.journal().write(cmd.operation, 'result', observed); }
      catch { return { status: 'uncertain', operation: cmd.operation, reason: 'outcome persistence failed; never redispatch' }; }
      return observed;
    } catch (error) {
      return { status: 'refused', reason: error instanceof Error ? error.message : 'unavailable' };
    }
  }
}
