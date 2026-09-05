/**
 * Panel data layer — process-agnostic builders and mutation appliers behind
 * every operator inspection surface (MCPL, settings, pins, health, context
 * debug). Extracted from web-ui-module.ts so the SAME code answers a panel
 * query whether the process is the WebUI host itself or a headless fleet
 * child asked over the fleet IPC:
 *
 *   WebUiModule (scope 'local')  ──┐
 *                                  ├──> runPanelOp(app, op, params)
 *   headless.ts ('panel-request') ─┘
 *
 * Everything here operates on a minimal `PanelAppRef` (framework + recipe +
 * optional call ledger), NOT on the full AppContext — keeps the layer free of
 * import cycles and callable from both runtimes.
 *
 * Results are wire-shaped JSON. Errors carry an optional HTTP-ish `status`
 * so the WebUI's HTTP proxy routes can answer faithfully (404 unknown agent,
 * 429 preview cooldown, 501 unsupported build).
 */

import type { AgentFramework } from '@animalabs/agent-framework';
import type { Recipe } from '../recipe.js';
import type { CallLedger } from '../call-ledger.js';
import {
  readMcplServersFile,
  DEFAULT_CONFIG_PATH,
} from '../mcpl-config.js';

/** Minimal slice of AppContext the panel layer needs. Both the WebUI host
 *  and the headless child runtime satisfy this structurally. */
export interface PanelAppRef {
  framework: AgentFramework;
  recipe: Recipe;
  /** Content-free recent provider-call ledger, when the host wired one. */
  callLedger?: CallLedger | null;
}

/** Panel operations servable by any conhost process. Kept as a const list so
 *  fleet-types.ts and tests can enumerate without importing the handlers. */
export const PANEL_OPS = [
  'mcpl',
  'settings',
  'settings-update',
  'settings-reset',
  'settings-cancel-transition',
  'pins',
  'pin-add',
  'pin-remove',
  'health',
  'context-makeup',
  'context-coverage',
  'context-curve',
  'context-preview',
  'context-maintenance',
  'debug-context',
] as const;
export type PanelOp = (typeof PANEL_OPS)[number];

export type PanelResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; status?: number };

/** Error carrying an HTTP-ish status through the shared layer. */
export class PanelError extends Error {
  constructor(message: string, readonly status: number = 500) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Run one panel op. Never throws — all failures come back as
 * `{ok:false, error, status}` so both callers (WS handler, IPC handler)
 * forward them without their own try/catch choreography.
 */
export async function runPanelOp(
  app: PanelAppRef,
  op: string,
  params: Record<string, unknown> = {},
): Promise<PanelResult> {
  try {
    switch (op as PanelOp) {
      case 'mcpl':
        return { ok: true, data: buildMcplSnapshot(app) };
      case 'settings':
        return { ok: true, data: requireSettingsState(app, resolveAgent(app, params.agent)) };
      case 'settings-update': {
        const agent = resolveAgent(app, params.agent);
        applySettingsUpdate(app, agent, params);
        if (params.notify === true) notifyAgentOfSettingsChange(app, agent, 'update');
        return { ok: true, data: requireSettingsState(app, agent) };
      }
      case 'settings-reset': {
        const agent = resolveAgent(app, params.agent);
        applySettingsReset(app, agent, params);
        if (params.notify === true) notifyAgentOfSettingsChange(app, agent, 'reset');
        return { ok: true, data: requireSettingsState(app, agent) };
      }
      case 'settings-cancel-transition': {
        const agent = resolveAgent(app, params.agent);
        applySettingsCancelTransition(app, agent);
        return { ok: true, data: requireSettingsState(app, agent) };
      }
      case 'pins':
        return {
          ok: true,
          data: buildPinsSnapshot(app, resolveAgent(app, params.agent), {
            withCandidates: params.withCandidates === true,
          }),
        };
      case 'pin-add': {
        const agent = resolveAgent(app, params.agent);
        applyPinAdd(app, agent, params);
        return { ok: true, data: buildPinsSnapshot(app, agent, { withCandidates: params.withCandidates === true }) };
      }
      case 'pin-remove': {
        const agent = resolveAgent(app, params.agent);
        const removed = applyPinRemove(app, agent, String(params.pinId ?? ''));
        const data = buildPinsSnapshot(app, agent, { withCandidates: params.withCandidates === true }) as unknown as Record<string, unknown>;
        // A stale panel can ask twice; report it without failing the refresh.
        if (!removed) data.warning = `no such pin: ${String(params.pinId ?? '')}`;
        return { ok: true, data };
      }
      case 'health':
        return { ok: true, data: buildHealthSnapshot(app) };
      case 'context-makeup':
        return { ok: true, data: await buildContextMakeup(app, resolveAgent(app, params.agent)) };
      case 'context-coverage':
        return { ok: true, data: buildContextCoverage(app, resolveAgent(app, params.agent)) };
      case 'context-curve':
        return { ok: true, data: await buildContextCurve(app, resolveAgent(app, params.agent)) };
      case 'context-preview':
        return { ok: true, data: runContextPreview(app, resolveAgent(app, params.agent), params) };
      case 'context-maintenance':
        return { ok: true, data: buildContextMaintenance(app) };
      case 'debug-context':
        return { ok: true, data: await buildDebugContext(app, resolveAgent(app, params.agent), params) };
      default:
        return { ok: false, error: `unknown panel op: ${op}`, status: 400 };
    }
  } catch (err) {
    if (err instanceof PanelError) return { ok: false, error: err.message, status: err.status };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Default to the recipe's primary agent when the caller omits a name. */
export function resolveAgent(app: PanelAppRef, name?: unknown): string {
  if (typeof name === 'string' && name.length > 0) return name;
  return app.recipe.agent.name ?? app.framework.getAllAgents()[0]?.name ?? 'agent';
}

function requireAgent(app: PanelAppRef, agentName: string): NonNullable<ReturnType<AgentFramework['getAgent']>> {
  const agent = app.framework.getAgent(agentName);
  if (!agent) throw new PanelError(`Agent not found: ${agentName}`, 404);
  return agent;
}

// ---------------------------------------------------------------------------
// MCPL
// ---------------------------------------------------------------------------

/** Live MCPL server state as this process's framework sees it. */
export interface McplLiveServer {
  id: string;
  connected: boolean;
  toolCount: number;
  toolPrefix?: string;
  /** command or url — whatever the transport targets. */
  target?: string;
}

/**
 * MCPL snapshot: the shared file registry (what the panel can edit) PLUS the
 * live servers this process actually loaded (recipe opt-in + agent overlay),
 * with connection status. The live list is what a fleet child meaningfully
 * differs on — the file is shared cwd-wide, but each recipe opts into its
 * own subset.
 */
export function buildMcplSnapshot(app: PanelAppRef): Record<string, unknown> {
  let servers: ReturnType<typeof readMcplServersFile> = {};
  try { servers = readMcplServersFile(DEFAULT_CONFIG_PATH); }
  catch { /* missing or malformed file → empty list */ }

  let live: McplLiveServer[] = [];
  try {
    const fw = app.framework as unknown as {
      listMcplServers?: () => Array<{
        id: string; connected?: boolean; toolCount?: number; toolPrefix?: string;
        command?: string; url?: string;
      }>;
    };
    if (typeof fw.listMcplServers === 'function') {
      live = fw.listMcplServers().map((s) => ({
        id: s.id,
        connected: s.connected === true,
        toolCount: s.toolCount ?? 0,
        ...(s.toolPrefix ? { toolPrefix: s.toolPrefix } : {}),
        ...(s.command || s.url ? { target: s.command ?? s.url } : {}),
      }));
    }
  } catch { /* live view is best-effort; the file registry still renders */ }

  return {
    configPath: DEFAULT_CONFIG_PATH,
    servers: Object.entries(servers).map(([id, entry]) => ({
      id,
      command: entry.command,
      ...(entry.args ? { args: entry.args } : {}),
      ...(entry.env ? { env: entry.env } : {}),
      ...(entry.toolPrefix ? { toolPrefix: entry.toolPrefix } : {}),
      ...(entry.reconnect !== undefined ? { reconnect: entry.reconnect } : {}),
      ...(entry.enabledFeatureSets ? { enabledFeatureSets: entry.enabledFeatureSets } : {}),
      ...(entry.disabledFeatureSets ? { disabledFeatureSets: entry.disabledFeatureSets } : {}),
    })),
    live,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsStateData {
  agent: string;
  settings: Record<string, unknown>;
  overrides: string[];
  hotKeys: string[];
  hotConfigurable: boolean;
  previewAvailable: boolean;
}

/**
 * Build the settings snapshot. Returns null when the framework build has no
 * runtime-settings surface at all: that is a legitimate state for the panel
 * to render read-only, not an error to surface.
 */
export function buildSettingsState(app: PanelAppRef, agentName: string): SettingsStateData | null {
  const fw = app.framework as unknown as {
    getAgentRuntimeSettings?: (n: string) => Record<string, unknown>;
  };
  if (typeof fw.getAgentRuntimeSettings !== 'function') return null;

  let settings: Record<string, unknown>;
  try {
    settings = fw.getAgentRuntimeSettings(agentName);
  } catch {
    return null;
  }

  // Which knobs this build can apply live, probed rather than assumed: the
  // hot set is a property of the ACTIVE strategy, not of the host version.
  let hotConfigurable = false;
  let previewAvailable = false;
  try {
    const agent = app.framework.getAgent(agentName);
    const cm = agent?.getContextManager() as unknown as {
      getHotContextSettings?: () => unknown;
      previewContext?: unknown;
    } | undefined;
    hotConfigurable = !!cm && typeof cm.getHotContextSettings === 'function'
      && cm.getHotContextSettings() !== null;
    previewAvailable = !!cm && typeof cm.previewContext === 'function';
  } catch { /* leave both false — read-only panel */ }

  const overrides: string[] = [];
  try {
    const agent = app.framework.getAgent(agentName) as unknown as {
      getRuntimeSettingsOverrides?: () => Record<string, unknown>;
    } | undefined;
    const ov = agent?.getRuntimeSettingsOverrides?.() ?? {};
    for (const [k, val] of Object.entries(ov)) if (val !== undefined) overrides.push(k);
  } catch { /* informational only */ }

  return {
    agent: agentName,
    settings,
    overrides,
    // contextBudgetTokens is applied by the Agent itself; the other three are
    // forwarded into the strategy's hot-settings channel, so they need a
    // hot-configurable strategy to mean anything.
    hotKeys: hotConfigurable
      ? ['contextBudgetTokens', 'tailTokens', 'transitionPaceTokens', 'sameRoundThinkTextPolicy']
      : ['contextBudgetTokens'],
    hotConfigurable,
    previewAvailable,
  };
}

function requireSettingsState(app: PanelAppRef, agentName: string): SettingsStateData {
  const state = buildSettingsState(app, agentName);
  if (!state) throw new PanelError('runtime settings unavailable on this build', 501);
  return state;
}

/** Apply a live settings patch. Throws with the framework's own message on
 *  rejection (budget ≤ max response tokens, non-hot strategy, ...). */
export function applySettingsUpdate(
  app: PanelAppRef,
  agentName: string,
  params: Record<string, unknown>,
): void {
  const patch: Record<string, number | boolean> = {};
  if (typeof params.contextBudgetTokens === 'number') patch.contextBudgetTokens = params.contextBudgetTokens;
  if (typeof params.tailTokens === 'number') patch.tailTokens = params.tailTokens;
  if (typeof params.transitionPaceTokens === 'number') patch.transitionPaceTokens = params.transitionPaceTokens;
  if (typeof params.immediate === 'boolean') patch.immediate = params.immediate;
  const fw = app.framework as unknown as {
    updateAgentRuntimeSettings: (n: string, p: unknown, o?: { persist?: boolean }) => unknown;
  };
  if (typeof fw.updateAgentRuntimeSettings !== 'function') {
    throw new PanelError('runtime settings unavailable on this build', 501);
  }
  fw.updateAgentRuntimeSettings(agentName, patch, { persist: params.persist !== false });
}

export function applySettingsReset(
  app: PanelAppRef,
  agentName: string,
  params: Record<string, unknown>,
): void {
  const fw = app.framework as unknown as {
    resetAgentRuntimeSettings: (n: string, k?: string[], o?: { persist?: boolean }) => unknown;
  };
  if (typeof fw.resetAgentRuntimeSettings !== 'function') {
    throw new PanelError('runtime settings unavailable on this build', 501);
  }
  const keys = Array.isArray(params.keys) ? (params.keys as string[]) : undefined;
  fw.resetAgentRuntimeSettings(agentName, keys, { persist: params.persist !== false });
}

export function applySettingsCancelTransition(app: PanelAppRef, agentName: string): void {
  const fw = app.framework as unknown as {
    cancelAgentRuntimeSettingsTransition: (n: string) => unknown;
  };
  if (typeof fw.cancelAgentRuntimeSettingsTransition !== 'function') {
    throw new PanelError('runtime settings unavailable on this build', 501);
  }
  fw.cancelAgentRuntimeSettingsTransition(agentName);
}

/**
 * Opt-in push notice to the agent that an operator changed its context
 * settings. OFF by default at the protocol level, because this injects text
 * into the very context being tuned: it invalidates the KV prefix and is
 * itself classifier-visible. The zero-cost alternative the agent always has
 * is to PULL via its `agent_settings` tool.
 */
export function notifyAgentOfSettingsChange(
  app: PanelAppRef,
  agentName: string,
  kind: 'update' | 'reset',
): void {
  try {
    const s = buildSettingsState(app, agentName);
    const budget = s?.settings.contextBudgetTokens;
    const tail = s?.settings.tailTokens;
    const transition = s?.settings.transition;
    const text = kind === 'reset'
      ? `[operator] context settings reset to recipe defaults`
      : `[operator] context settings changed`
        + (budget !== undefined ? ` — budget ${budget}` : '')
        + (tail !== undefined ? `, tail ${tail}` : '')
        + (transition === 'converging' ? ' (converging gradually)' : '');
    const cm = app.framework.getAgent(agentName)?.getContextManager();
    cm?.addMessage('Context Manager', [{ type: 'text', text }], { system: true });
  } catch (err) {
    // A failed notice must never fail the apply that already succeeded.
    console.warn('[settings] notify failed (change still applied):', err);
  }
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

export interface PinsSnapshotData {
  agent: string;
  pins: Array<{
    id: string;
    firstMessageId: string;
    lastMessageId: string;
    kind: 'pin' | 'document';
    name?: string;
    created: number;
    level?: number;
    maxLevel?: number;
  }>;
  pinsSupported: boolean;
  levelHonored: boolean;
  deepestLevel?: number;
  /** Recent pinnable messages (real store ids), when requested. Lets a
   *  remote panel offer its picker without holding this process's
   *  conversation window. */
  candidates?: Array<{ id: string; index: number; participant: string; text: string }>;
}

/** Duck-typed pin surface. Throws with a clear reason rather than returning a
 *  half-usable object, so callers can report it to the operator verbatim. */
function pinnableCm(app: PanelAppRef, agentName: string): {
  pinRange?: (a: string, b: string, o?: unknown) => string;
  markDocument?: (a: string, o?: unknown) => string;
  unpin?: (id: string) => boolean;
  listPins?: () => ReadonlyArray<Record<string, unknown>>;
} {
  const agent = requireAgent(app, agentName);
  const cm = agent.getContextManager() as unknown as {
    pinRange?: (a: string, b: string, o?: unknown) => string;
    markDocument?: (a: string, o?: unknown) => string;
    unpin?: (id: string) => boolean;
    listPins?: () => ReadonlyArray<Record<string, unknown>>;
  };
  if (typeof cm.listPins !== 'function' || typeof cm.pinRange !== 'function') {
    throw new PanelError('the active context strategy does not support pins', 501);
  }
  return cm;
}

/** How many recent messages a pins snapshot ships as picker candidates. */
const PIN_CANDIDATE_LIMIT = 200;
const PIN_CANDIDATE_TEXT_CAP = 160;

/**
 * Pin snapshot. Never throws for an unsupported strategy — that's a
 * legitimate read-only state for the panel, not an error.
 *
 * `levelHonored` matters: pin-AT-level is implemented only by the kv-stable
 * controller. Elsewhere it degrades to raw, which is a safe superset but not
 * what the operator asked for, so the UI needs to be able to say so.
 */
export function buildPinsSnapshot(
  app: PanelAppRef,
  agentName: string,
  opts: { withCandidates?: boolean } = {},
): PinsSnapshotData {
  let pins: PinsSnapshotData['pins'] = [];
  let supported = false;
  try {
    const cm = pinnableCm(app, agentName);
    pins = (cm.listPins!() ?? []).map((p) => ({
      id: String(p.id),
      firstMessageId: String(p.firstMessageId),
      lastMessageId: String(p.lastMessageId),
      kind: p.kind === 'document' ? 'document' : 'pin',
      ...(typeof p.name === 'string' ? { name: p.name } : {}),
      created: typeof p.created === 'number' ? p.created : 0,
      ...(typeof p.level === 'number' ? { level: p.level } : {}),
      ...(typeof p.maxLevel === 'number' ? { maxLevel: p.maxLevel } : {}),
    }));
    supported = true;
  } catch (err) {
    // Unknown agent is a real error; unsupported strategy is a state.
    if (err instanceof PanelError && err.status === 404) throw err;
    supported = false;
  }

  let levelHonored = false;
  let deepestLevel: number | undefined;
  try {
    const strategyCfg = (app.recipe.agent as unknown as {
      strategy?: { foldingStrategy?: string };
    }).strategy;
    levelHonored = strategyCfg?.foldingStrategy === 'kv-stable';
    const agent = app.framework.getAgent(agentName);
    const cm = agent?.getContextManager() as unknown as {
      getSummaries?: () => Array<{ level?: number }>;
    } | undefined;
    const sums = cm?.getSummaries?.() ?? [];
    for (const s of sums) {
      if (typeof s.level === 'number' && (deepestLevel === undefined || s.level > deepestLevel)) {
        deepestLevel = s.level;
      }
    }
  } catch { /* informational only */ }

  return {
    agent: agentName,
    pins,
    pinsSupported: supported,
    levelHonored,
    ...(deepestLevel !== undefined ? { deepestLevel } : {}),
    ...(opts.withCandidates ? { candidates: buildPinCandidates(app, agentName) } : {}),
  };
}

/**
 * Recent pinnable messages with REAL store ids. Mirrors the client-side
 * candidate list the local panel builds from its own message window — a
 * remote (fleet-child) panel has no such window, so the snapshot carries one.
 */
function buildPinCandidates(
  app: PanelAppRef,
  agentName: string,
): Array<{ id: string; index: number; participant: string; text: string }> {
  try {
    const agent = app.framework.getAgent(agentName);
    const cm = agent?.getContextManager() as unknown as {
      getMessageCount?: () => number;
      getMessageWindow?: (
        offset: number, limit: number, opts?: { resolveBlobs?: boolean },
      ) => { messages: Array<{ id?: string; participant?: string; content?: unknown }>; startIndex: number };
    } | undefined;
    if (!cm || typeof cm.getMessageCount !== 'function' || typeof cm.getMessageWindow !== 'function') {
      return [];
    }
    const total = cm.getMessageCount();
    const start = Math.max(0, total - PIN_CANDIDATE_LIMIT);
    const win = cm.getMessageWindow(start, total - start, { resolveBlobs: false });
    const out: Array<{ id: string; index: number; participant: string; text: string }> = [];
    win.messages.forEach((m, i) => {
      if (!m.id) return;
      let text = '';
      if (Array.isArray(m.content)) {
        for (const b of m.content as Array<Record<string, unknown>>) {
          if (b?.type === 'text') text += String(b.text ?? '');
        }
      } else if (typeof m.content === 'string') {
        text = m.content;
      }
      out.push({
        id: String(m.id),
        index: win.startIndex + i,
        participant: String(m.participant ?? '?'),
        text: text.slice(0, PIN_CANDIDATE_TEXT_CAP),
      });
    });
    return out;
  } catch {
    return [];
  }
}

export function applyPinAdd(app: PanelAppRef, agentName: string, params: Record<string, unknown>): void {
  const cm = pinnableCm(app, agentName);
  const firstMessageId = String(params.firstMessageId ?? '');
  if (!firstMessageId) throw new PanelError('firstMessageId required', 400);
  const opts: Record<string, unknown> = {};
  if (params.name !== undefined) opts.name = params.name;
  if (params.level !== undefined) opts.level = params.level;
  if (params.maxLevel !== undefined) opts.maxLevel = params.maxLevel;
  if (params.kind === 'document') {
    cm.markDocument!(firstMessageId, opts);
  } else {
    // A single-message pin is a range of one; the strategy takes both ends.
    cm.pinRange!(firstMessageId, String(params.lastMessageId ?? firstMessageId), opts);
  }
}

/** Returns false when no such pin existed (stale panel double-click). */
export function applyPinRemove(app: PanelAppRef, agentName: string, pinId: string): boolean {
  const cm = pinnableCm(app, agentName);
  if (!pinId) throw new PanelError('pinId required', 400);
  return cm.unpin!(pinId);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Liveness/health snapshot — the /healthz assembly. framework.healthSnapshot
 * plus compression quarantine, rendered context composition, per-agent
 * runtime settings, and (when a ledger is wired) recent provider calls.
 * Everything is read-only and cheap: no compile, no count_tokens.
 */
export function buildHealthSnapshot(app: PanelAppRef): Record<string, unknown> {
  const fw = app.framework as unknown as { healthSnapshot?: () => Record<string, unknown> };
  if (typeof fw.healthSnapshot !== 'function') {
    throw new PanelError('framework lacks healthSnapshot()', 501);
  }
  const snapshot = fw.healthSnapshot();
  // Compression quarantine is a guaranteed-eventual-outage state (raw
  // spans accumulate until the picker cannot fit the window). Surface it
  // here so the fleet hub and connectome-doctor can alarm on it — it
  // must never be observable only in agent.log.
  try {
    const quarantine: Record<string, unknown> = {};
    for (const agent of app.framework.getAllAgents()) {
      const strategy = (agent.getContextManager() as unknown as {
        getStrategy?: () => { getCompressionQuarantineStatus?: () => unknown };
      }).getStrategy?.();
      const status = strategy?.getCompressionQuarantineStatus?.();
      if (status) quarantine[(agent as unknown as { name: string }).name] = status;
    }
    (snapshot as Record<string, unknown>).compressionQuarantine = quarantine;
  } catch {
    // Health reads never throw.
  }
  // Compression DEBT per agent — the single-authority reduction from cm
  // (healthy / degraded / critical + the numbers behind it). Every wedge of
  // the 2026-08-06 five-resident day was weeks of silently-failing
  // compression surfacing as a sudden budget crisis; this block is what
  // lets fleet-watch (and later the resident notice, af #99) catch the
  // debt while it is still cheap.
  try {
    const debt: Record<string, unknown> = {};
    for (const agent of app.framework.getAllAgents()) {
      const strategy = (agent.getContextManager() as unknown as {
        getStrategy?: () => { getCompressionDebt?: () => unknown };
      }).getStrategy?.();
      const d = strategy?.getCompressionDebt?.();
      if (d) debt[(agent as unknown as { name: string }).name] = d;
    }
    (snapshot as Record<string, unknown>).compressionDebt = debt;
  } catch {
    // Health reads never throw.
  }
  // Rendered context COMPOSITION per agent — head / raw middle / summaries
  // by level / tail, as actually emitted by the last compile. Sourced from
  // the strategy's own render stats (already computed in-process), so it is
  // safe on the 15s /healthz poll.
  try {
    const composition: Record<string, unknown> = {};
    for (const agent of app.framework.getAllAgents()) {
      const name = (agent as unknown as { name: string }).name;
      const cm = agent.getContextManager() as unknown as {
        getRenderStats?: () => unknown;
      };
      const rs = cm.getRenderStats?.();
      if (rs) composition[name] = rs;
    }
    (snapshot as Record<string, unknown>).contextComposition = composition;
  } catch {
    // Health reads never throw.
  }
  // Per-agent runtime settings (context budget, tail, transition pace +
  // convergence state) — the same numbers `agent_settings get` returns,
  // exposed externally so the fleet hub / connectome-doctor can watch
  // budget convergence without an agent turn.
  try {
    const fw2 = app.framework as unknown as {
      getAgentRuntimeSettings?: (name: string) => unknown;
    };
    if (typeof fw2.getAgentRuntimeSettings === 'function') {
      const settings: Record<string, unknown> = {};
      for (const agent of app.framework.getAllAgents()) {
        const name = (agent as unknown as { name: string }).name;
        settings[name] = fw2.getAgentRuntimeSettings(name);
      }
      (snapshot as Record<string, unknown>).runtimeSettings = settings;
    }
  } catch {
    // Health reads never throw.
  }
  // Recent provider calls. The WebUI host streams these over its own WS;
  // for a fleet child this snapshot is the only path, so ship them here.
  try {
    const ledger = app.callLedger?.snapshot();
    if (ledger) (snapshot as Record<string, unknown>).callLedger = ledger;
  } catch {
    // Health reads never throw.
  }
  return snapshot;
}

/**
 * Counts-only state and bounded history for periodic context maintenance.
 * The framework snapshot deliberately contains no message or summary text.
 */
export function buildContextMaintenance(app: PanelAppRef): Record<string, unknown> {
  const framework = app.framework as unknown as {
    getContextMaintenanceSnapshot?: () => Record<string, unknown>;
  };
  if (typeof framework.getContextMaintenanceSnapshot !== 'function') {
    throw new PanelError('framework lacks context-maintenance diagnostics', 501);
  }
  return framework.getContextMaintenanceSnapshot();
}

// ---------------------------------------------------------------------------
// Context debug (makeup / coverage / curve / preview / raw request)
// ---------------------------------------------------------------------------

interface CoverageSummary {
  id: string;
  level: number;
  tokens?: number;
  sourceIds?: string[];
  mergedInto?: string;
}

interface CoverageChunk {
  index: number;
  tokens?: number;
  compressed?: boolean;
  summaryId?: string;
  messages?: Array<{ id?: string }>;
}

interface CoverageStrategy {
  summaries?: CoverageSummary[];
  chunks?: CoverageChunk[];
  compressionQueue?: number[];
  mergeQueue?: Array<{ level: number; sourceIds: string[] }>;
  resolutions?: Map<string, number>;
  pendingCompression?: Promise<void> | null;
}

export interface ContextCoverageSnapshot {
  agent: string;
  branch: string;
  generatedAt: string;
  supported: boolean;
  totals: {
    chunks: number;
    compressedChunks: number;
    coveredMessages: number;
    coveredTokens: number;
    summaries: number;
  };
  levels: Array<{
    level: number;
    summaries: number;
    frontier: number;
    tokens: number;
    coveredChunks: number;
    coveredMessages: number;
    coveredTokens: number;
  }>;
  chunks: Array<{
    index: number;
    messages: number;
    tokens: number;
    compressed: boolean;
    summaryId: string | null;
    maxLevel: number;
    selectedMin: number;
    selectedMax: number;
    queued: boolean;
  }>;
  queue: {
    inFlight: boolean;
    pending: string | null;
    l1: number[];
    merges: Array<{ targetLevel: number; sourceCount: number; firstSource: string | null; lastSource: string | null }>;
  };
}

/** Build a text-free projection of the autobiographical summary pyramid. */
export function buildContextCoverageSnapshot(
  agentName: string,
  cm: {
    currentBranch: () => { name: string };
    getStrategy: () => unknown;
    getPendingWork?: () => { description?: string } | null;
  },
): ContextCoverageSnapshot {
  const strategy = cm.getStrategy() as CoverageStrategy;
  const summaries = Array.isArray(strategy.summaries) ? strategy.summaries : [];
  const chunks = Array.isArray(strategy.chunks) ? strategy.chunks : [];
  const compressionQueue = Array.isArray(strategy.compressionQueue) ? strategy.compressionQueue : [];
  const mergeQueue = Array.isArray(strategy.mergeQueue) ? strategy.mergeQueue : [];
  const resolutions = strategy.resolutions instanceof Map ? strategy.resolutions : new Map<string, number>();
  const summaryById = new Map(summaries.map(summary => [summary.id, summary]));
  const queuedChunks = new Set(compressionQueue);

  const projectedChunks = chunks.map((chunk) => {
    let maxLevel = 0;
    let current = chunk.summaryId ? summaryById.get(chunk.summaryId) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      maxLevel = Math.max(maxLevel, current.level);
      current = current.mergedInto ? summaryById.get(current.mergedInto) : undefined;
    }

    const selected = (chunk.messages ?? [])
      .map(message => typeof message.id === 'string' ? (resolutions.get(message.id) ?? 0) : 0);
    return {
      index: chunk.index,
      messages: chunk.messages?.length ?? 0,
      tokens: Math.max(0, chunk.tokens ?? 0),
      compressed: chunk.compressed === true,
      summaryId: chunk.summaryId ?? null,
      maxLevel,
      selectedMin: selected.length > 0 ? Math.min(...selected) : 0,
      selectedMax: selected.length > 0 ? Math.max(...selected) : 0,
      queued: queuedChunks.has(chunk.index),
    };
  });

  const levelNumbers = [...new Set(summaries.map(summary => summary.level))]
    .filter(level => Number.isFinite(level) && level > 0)
    .sort((a, b) => a - b);
  const levels = levelNumbers.map((level) => {
    const atLevel = summaries.filter(summary => summary.level === level);
    const covered = projectedChunks.filter(chunk => chunk.maxLevel >= level);
    return {
      level,
      summaries: atLevel.length,
      frontier: atLevel.filter(summary => !summary.mergedInto).length,
      tokens: atLevel.reduce((total, summary) => total + Math.max(0, summary.tokens ?? 0), 0),
      coveredChunks: covered.length,
      coveredMessages: covered.reduce((total, chunk) => total + chunk.messages, 0),
      coveredTokens: covered.reduce((total, chunk) => total + chunk.tokens, 0),
    };
  });
  const covered = projectedChunks.filter(chunk => chunk.maxLevel > 0);
  const pending = cm.getPendingWork?.()?.description ?? null;

  return {
    agent: agentName,
    branch: cm.currentBranch().name,
    generatedAt: new Date().toISOString(),
    supported: Array.isArray(strategy.summaries) && Array.isArray(strategy.chunks),
    totals: {
      chunks: projectedChunks.length,
      compressedChunks: projectedChunks.filter(chunk => chunk.compressed).length,
      coveredMessages: covered.reduce((total, chunk) => total + chunk.messages, 0),
      coveredTokens: covered.reduce((total, chunk) => total + chunk.tokens, 0),
      summaries: summaries.length,
    },
    levels,
    chunks: projectedChunks,
    queue: {
      inFlight: strategy.pendingCompression != null,
      pending,
      l1: [...compressionQueue],
      merges: mergeQueue.map(merge => ({
        targetLevel: merge.level,
        sourceCount: merge.sourceIds.length,
        firstSource: merge.sourceIds[0] ?? null,
        lastSource: merge.sourceIds[merge.sourceIds.length - 1] ?? null,
      })),
    },
  };
}

/**
 * Best-effort mapping from an agent's configured model string to a bare
 * Anthropic API model id for /v1/messages/count_tokens. Handles membrane /
 * OpenRouter provider prefixes ("anthropic/claude-…", "…/anthropic/claude-…")
 * and Bedrock ids ("us.anthropic.claude-…-v1:0"). Returns null for
 * non-Anthropic models — exact counting is unsupported there, and reporting
 * that honestly beats 404ing against a wrong tokenizer.
 */
export function anthropicCountModel(agentModel: string | undefined): string | null {
  if (!agentModel) return null;
  let m = agentModel;
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  m = m.replace(/^(us|eu|apac)\./, '').replace(/^anthropic\./, '').replace(/-v\d+:\d+$/, '');
  return m.startsWith('claude') ? m : null;
}

/** Summary-tree coverage and queued work, with no message or summary text. */
export function buildContextCoverage(app: PanelAppRef, agentName: string): ContextCoverageSnapshot {
  const agent = requireAgent(app, agentName);
  return buildContextCoverageSnapshot(agentName, agent.getContextManager());
}

/**
 * Context makeup: the segment breakdown of the agent's current compiled
 * context — head window, raw middle, summaries by level (L1/L2/L3), and the
 * recent verbatim tail — from the strategy's RenderStats, plus an exact
 * total token count via the model's count_tokens endpoint. Transparent:
 * previewActivation + count_tokens only; no inference, no Chronicle writes.
 */
export async function buildContextMakeup(app: PanelAppRef, agentName: string): Promise<Record<string, unknown>> {
  const agent = requireAgent(app, agentName);
  // Populates the strategy's render stats as a side-effect of compiling.
  const request = await app.framework.previewActivation(agentName);
  const cm = (agent as unknown as { getContextManager: () => { getRenderStats: () => unknown } }).getContextManager();
  const stats = cm.getRenderStats();

  // Build an Anthropic-faithful payload for an exact count_tokens: map
  // participants to roles (the agent's own -> assistant, others -> user
  // with a "Name:" prefix) and merge consecutive same-role runs, mirroring
  // what the NativeFormatter sends.
  const textOf = (c: unknown): string =>
    Array.isArray(c)
      ? c.map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text: string }).text : '')).join('')
      : String(c ?? '');
  const merged: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const m of ((request as { messages?: Array<{ participant?: string; role?: string; content: unknown }> }).messages ?? [])) {
    const who = m.participant ?? m.role ?? 'user';
    const role: 'user' | 'assistant' = who === agentName ? 'assistant' : 'user';
    let t = textOf(m.content);
    if (role === 'user' && who && who !== 'user') t = `${who}: ${t}`;
    const last = merged[merged.length - 1];
    if (last && last.role === role) last.text += '\n' + t;
    else merged.push({ role, text: t });
  }
  const anthMessages = merged.filter((m) => m.text.trim().length > 0).map((m) => ({ role: m.role, content: m.text }));
  const sysRaw = (request as { system?: unknown }).system;
  const systemStr = Array.isArray(sysRaw)
    ? sysRaw.map((b) => (b && typeof b === 'object' ? (b as { text?: string }).text ?? '' : String(b))).join('\n')
    : (typeof sysRaw === 'string' ? sysRaw : undefined);

  let exactTotalTokens: number | null = null;
  // Count against the model the agent actually runs, not a hardcoded id:
  // a stale/foreign id 404s and exact counts silently degrade to null on
  // every install. COUNT_TOKENS_MODEL stays as an explicit operator override.
  const countModel = process.env.COUNT_TOKENS_MODEL
    || anthropicCountModel((agent as { model?: string }).model);
  let countSource = 'count_tokens';
  if (!countModel) {
    return { agent: agentName, stats, exactTotalTokens, countModel, countSource: 'count_tokens_unsupported_model' };
  }
  try {
    const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    const res = await fetch(base + '/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        // Mirror the main adapter's auth: OAuth Bearer (subscription) when
        // ANTHROPIC_AUTH_TOKEN is set, x-api-key otherwise.
        ...(process.env.ANTHROPIC_AUTH_TOKEN
          ? {
              authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`,
              'anthropic-beta': 'oauth-2025-04-20',
            }
          : { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '' }),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'user-agent': 'conhost/1.0',
      },
      body: JSON.stringify({ model: countModel, ...(systemStr ? { system: systemStr } : {}), messages: anthMessages }),
    });
    if (res.ok) {
      const j = (await res.json()) as { input_tokens?: number };
      exactTotalTokens = j.input_tokens ?? null;
    } else {
      countSource = `count_tokens_failed_${res.status}`;
    }
  } catch {
    countSource = 'count_tokens_error';
  }

  return { agent: agentName, stats, exactTotalTokens, countModel, countSource };
}

/**
 * Context curve: compile the agent's window and return one record per
 * compiled entry with its provenance — kind (raw / L1..Ln summary), rendered
 * token estimate, the raw-history tokens it covers (leaf messages,
 * recursively through the summary tree), date span, and full text.
 *
 * Same side-effect class as previewActivation / makeup: the compile may
 * commit resolution updates, exactly as the agent's own next turn would.
 * No inference, no message writes.
 */
export async function buildContextCurve(app: PanelAppRef, agentName: string): Promise<Record<string, unknown>> {
  requireAgent(app, agentName);
  const agent = app.framework.getAgent(agentName)!;
  const cm = (agent as unknown as { getContextManager: () => any }).getContextManager();
  // Use the LIVE budget, not the recipe's. Runtime overrides persist in the
  // `framework/state` Chronicle slot and win over the recipe, so reading
  // app.recipe here plotted the wrong curve on any agent whose budget had
  // ever been changed at runtime. Fall back to the recipe only if the live
  // read is unavailable.
  let maxTokens = app.recipe.agent.contextBudgetTokens ?? 200_000;
  try {
    const live = (app.framework as unknown as {
      getAgentRuntimeSettings?: (n: string) => { contextBudgetTokens?: number };
    }).getAgentRuntimeSettings?.(agentName)?.contextBudgetTokens;
    if (typeof live === 'number' && live > 0) maxTokens = live;
  } catch { /* keep the recipe fallback */ }
  const reserveForResponse = app.recipe.agent.maxTokens ?? 16_384;
  const compiled = await cm.compile({ maxTokens, reserveForResponse });

  // Curve inspection only needs text and source metadata. Resolving every
  // historical blob here re-inlines all base64 media and can expand a
  // few-hundred-MB Chronicle into several GB of JS heap. Use the windowed
  // reader with blob resolution disabled so production diagnostics stay
  // bounded by text history rather than the media archive.
  const messageCount = cm.getMessageCount();
  const messages: Array<{ id: string; timestamp?: unknown; content?: unknown[] }> =
    cm.getMessageWindow(0, messageCount, { resolveBlobs: false }).messages;
  const msgById = new Map(messages.map((mm) => [mm.id, mm]));
  const estimate = (mm: { content?: unknown[] }): number => {
    let t = 0;
    for (const b of (mm.content ?? []) as Array<Record<string, unknown>>) {
      if (b?.type === 'text') t += Math.ceil(String(b.text ?? '').length / 4);
      else if (b?.type === 'image') t += 1600;
      else if (b?.type === 'tool_result') t += Math.ceil(JSON.stringify(b.content ?? '').length / 4);
      else if (b?.type === 'tool_use') t += Math.ceil(JSON.stringify(b.input ?? {}).length / 4);
      else if (b?.type === 'thinking') t += Math.ceil(String(b.thinking ?? '').length / 4);
    }
    return t;
  };

  type Summary = { id: string; level: number; content: string; sourceLevel: number; sourceIds: string[] };
  const strategy = cm.getStrategy() as { summaries?: Summary[] };
  const sums: Summary[] = strategy.summaries ?? [];
  const sumById = new Map(sums.map((x) => [x.id, x]));
  const headOf = (txt: string): string => txt.replace(/\s+/g, ' ').slice(0, 100);
  const byHead = new Map(sums.map((x) => [headOf(x.content), x]));
  const leaves = (x: Summary, seen = new Set<string>()): string[] => {
    if (seen.has(x.id)) return [];
    seen.add(x.id);
    if (x.sourceLevel === 0) return x.sourceIds;
    const out: string[] = [];
    for (const cid of x.sourceIds) {
      const c = sumById.get(cid);
      if (c) out.push(...leaves(c, seen));
    }
    return out;
  };

  const entries = [];
  let i = 0;
  for (const e of compiled.messages as Array<{ participant: string; content?: unknown[]; sourceMessageId?: string }>) {
    const blocks = (e.content ?? []) as Array<Record<string, unknown>>;
    const text = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n');
    const nImages = blocks.filter((b) => b?.type === 'image').length;
    const rendered = Math.ceil(text.length / 4) + nImages * 1600 +
      blocks.filter((b) => b?.type === 'tool_result' || b?.type === 'tool_use')
        .reduce((a, b) => a + Math.ceil(JSON.stringify(b.input ?? b.content ?? '').length / 4), 0);
    const sum = byHead.get(headOf(text));
    if (sum) {
      const leafIds = leaves(sum).filter((id) => msgById.has(id));
      const rawCovered = leafIds.reduce((a, id) => a + estimate(msgById.get(id)!), 0);
      const dates = leafIds.map((id) => msgById.get(id)!.timestamp).filter(Boolean).sort();
      entries.push({
        i: i++, kind: `L${sum.level}`, id: sum.id, participant: e.participant,
        rendered, rawCovered, msgCount: leafIds.length, nImages,
        dateFirst: dates[0] ?? null, dateLast: dates[dates.length - 1] ?? null, text,
      });
    } else {
      const src = e.sourceMessageId ? msgById.get(e.sourceMessageId) : null;
      entries.push({
        i: i++, kind: 'raw', id: e.sourceMessageId ?? null, participant: e.participant,
        rendered, rawCovered: src ? estimate(src) : rendered, msgCount: 1, nImages,
        dateFirst: src?.timestamp ?? null, dateLast: src?.timestamp ?? null, text,
      });
    }
  }
  return {
    agent: agentName,
    generatedAt: new Date().toISOString(),
    branch: cm.currentBranch().name,
    budget: { maxTokens, reserveForResponse },
    totals: {
      entries: entries.length,
      rendered: entries.reduce((a, e) => a + e.rendered, 0),
      rawCovered: entries.reduce((a, e) => a + e.rawCovered, 0),
    },
    entries,
  };
}

/**
 * Single-flight + cooldown for preview, PER PROCESS.
 *
 * A preview is a real compile: ~8s on a large store, and `select()` is
 * synchronous so it BLOCKS the agent's event loop for that whole time (no
 * heartbeat, no Discord, no MCPL). Overlapping or rapid-fire previews
 * therefore don't just queue — they stack agent stalls. Reject instead.
 * Module-level state on purpose: the guard protects this process's agent,
 * regardless of which surface (HTTP handler, fleet IPC) asked.
 */
let previewInFlight = false;
let previewLastAt = 0;
const PREVIEW_COOLDOWN_MS = 3_000;

/**
 * Replace the dry run's full rendered entries with a compact display
 * projection.
 *
 * Shipping the entries verbatim cost ~110s of BLOCKED AGENT on Mythos (353
 * entries, megabytes of content plus any inlined media) against ~8s for the
 * numbers-only path — and select() builds those entries either way, so the
 * extra ~100s was pure serialization of data the UI never shows in full: the
 * pane truncates every body past 600 chars anyway.
 *
 * So: keep identity, size and a bounded text preview; drop content blocks and
 * never inline media.
 */
function projectDryEntries(result: unknown): unknown {
  const r = result as { entries?: unknown[] } & Record<string, unknown>;
  if (!Array.isArray(r.entries)) return result;
  const MAX_TEXT = 1_200;
  const projected = r.entries.map((e, i) => {
    const o = (e ?? {}) as { participant?: string; role?: string; content?: unknown };
    let text = '';
    let media = 0;
    const blocks = Array.isArray(o.content) ? o.content : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') { text += String(b ?? ''); continue; }
      const t = (b as { type?: string }).type;
      if (t === 'text') text += (b as { text?: string }).text ?? '';
      else if (t === 'image') { media++; text += '[image]'; }
      else if (t === 'thinking' || t === 'redacted_thinking') text += '[thinking]';
      else if (t === 'tool_use') text += `[tool_use ${(b as { name?: string }).name ?? ''}]`;
      else if (t === 'tool_result') text += '[tool_result]';
    }
    if (typeof o.content === 'string') text = o.content;
    return {
      i,
      who: o.participant ?? o.role ?? '?',
      chars: text.length,
      media,
      truncated: text.length > MAX_TEXT,
      text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
    };
  });
  return { ...r, entries: projected };
}

/**
 * Preview the fold plan at a HYPOTHETICAL budget / tail, without applying it.
 * Commits nothing — no fold resolutions persisted, no compression enqueued,
 * no transition bookkeeping advanced. An infeasible budget is reported as
 * diagnostics, NOT as an error: learning that a budget can't work is the
 * reason to preview instead of applying and taking the outage.
 *
 * params: { budget: number; tail?: number; render?: boolean }
 */
export function runContextPreview(
  app: PanelAppRef,
  agentName: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  requireAgent(app, agentName);

  const budget = Number(params.budget);
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new PanelError('budget must be a positive integer', 400);
  }
  const overrides: Record<string, unknown> = {};
  if (params.tail !== undefined) {
    const tail = Number(params.tail);
    if (!Number.isSafeInteger(tail) || tail < 0) {
      throw new PanelError('tail must be a non-negative integer', 400);
    }
    // The strategy knob behind "tail" is recentWindowTokens.
    overrides.recentWindowTokens = tail;
  }
  const wantRender = params.render === true || params.render === '1' || params.render === 1;

  if (previewInFlight) {
    throw new PanelError(
      'a preview is already running — it blocks the agent, so they are serialized', 429,
    );
  }
  const sinceLast = Date.now() - previewLastAt;
  if (sinceLast < PREVIEW_COOLDOWN_MS) {
    throw new PanelError(
      `preview cooling down — ${Math.ceil((PREVIEW_COOLDOWN_MS - sinceLast) / 1000)}s left. `
        + 'Each run is a full compile and briefly pauses the agent.', 429,
    );
  }

  const fw = app.framework as unknown as {
    previewContextSettings?: (
      n: string, b: number, o?: Record<string, unknown>, x?: { render?: boolean },
    ) => unknown;
  };
  if (typeof fw.previewContextSettings !== 'function') {
    throw new PanelError(
      'preview unsupported: this agent-framework build has no previewContextSettings', 501,
    );
  }
  previewInFlight = true;
  const startedAt = Date.now();
  try {
    const result = fw.previewContextSettings(
      agentName,
      budget,
      Object.keys(overrides).length > 0 ? overrides : undefined,
      wantRender ? { render: true } : undefined,
    );
    if (result === null || result === undefined) {
      throw new PanelError(
        'preview unavailable: the resolved context-manager has no dry-run support, '
          + 'or the active strategy has no fold plan (non-adaptive)', 501,
      );
    }
    // Honest budget accounting. context-manager's `budgetTokens` is the
    // REJECTION budget: (requested - reserve) * (1 + overBudgetGraceRatio),
    // i.e. the threshold above which a compile throws. Its `fits` therefore
    // means "would not hard-fail", NOT "fits the budget you asked for".
    const r = result as { finalTokens?: number; budgetTokens?: number; exhausted?: boolean };
    const reserve = app.recipe.agent.maxTokens ?? 16_384;
    const effectiveBudget = Math.max(0, budget - reserve);
    const finalTokens = typeof r.finalTokens === 'number' ? r.finalTokens : NaN;
    const fitsRequested = Number.isFinite(finalTokens) && finalTokens <= effectiveBudget;
    const withinGrace = Number.isFinite(finalTokens) && typeof r.budgetTokens === 'number'
      ? finalTokens <= r.budgetTokens
      : undefined;
    return {
      agent: agentName,
      budget,
      ...(overrides as object),
      accounting: {
        requestedBudgetTokens: budget,
        reserveForResponseTokens: reserve,
        /** What the picker actually targets. */
        effectiveBudgetTokens: effectiveBudget,
        /** Hard-fail ceiling — requested minus reserve, plus grace. */
        rejectionBudgetTokens: r.budgetTokens,
        /** Fits the budget the operator asked for. */
        fitsRequested,
        /** Merely tolerated by the grace margin — over budget, but no throw. */
        withinGrace,
        /** Exhausted AND over the request => this budget is UNREACHABLE. */
        unreachable: r.exhausted === true && !fitsRequested,
      },
      /** How long the agent was blocked, so the operator sees the real cost. */
      elapsedMs: Date.now() - startedAt,
      preview: wantRender ? projectDryEntries(result) : result,
    };
  } finally {
    previewInFlight = false;
    previewLastAt = Date.now();
  }
}

/**
 * The membrane-normalized request the framework would hand to the model if
 * the agent were activated right now. Delegates to `framework.previewActivation`.
 *
 * Transparent by default: no inference, no Chronicle writes, no external
 * MCPL calls. Pass `injections: true` to gather dynamic injections
 * (lessons/retrieval/MCPL context) for full fidelity, which is NOT
 * transparent: it can run inference and fire MCPL `beforeInference` hooks.
 */
export async function buildDebugContext(
  app: PanelAppRef,
  agentName: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  requireAgent(app, agentName);
  const injections = params.injections === true;
  const request = await app.framework.previewActivation(agentName, { injections });
  return { agent: agentName, injections, transparent: !injections, request };
}
