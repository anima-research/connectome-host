import type { AgentFramework } from '@animalabs/agent-framework';
import { NativeFormatter } from '@animalabs/membrane';
import type { ContentBlock, NormalizedMessage, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';
import { recipeModel, resolveProvider, type Recipe } from '../recipe.js';
import { anthropicXmlFormatter, xmlToolsInSystem } from '../recipe-formatter.js';
import type { CallLedger } from '../call-ledger.js';
import type { QuotaMeter } from '../quota-meter.js';
import type { CredentialMonitor, CredentialActionId } from '../credential-state.js';
import {
  readMcplServersFile,
  DEFAULT_CONFIG_PATH,
} from '../mcpl-config.js';
import {
  countToolClassSources,
  readToolClasses,
  type ToolClassRow,
  type ToolClassSource,
} from '../tool-lifecycle-config.js';
import { effectiveContextBudgetTokens, effectiveMaxTokens } from '../recipe-fit.js';
import { hostUpdate } from '../update/update.js';

export interface PanelAppRef {
  framework: AgentFramework;
  recipe: Recipe;
  callLedger?: CallLedger | null;
  quotaMeter?: QuotaMeter | null;
  credentials?: CredentialMonitor | null;
  subscriptionUnmetered?: boolean;
}

export const PANEL_OPS = [
  'mcpl',
  'tool-classes',
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
  'media',
  'quota',
  'credential',
  'credential-action',
] as const;
export type PanelOp = (typeof PANEL_OPS)[number];

export type PanelResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; status?: number };

export class PanelError extends Error {
  constructor(message: string, readonly status: number = 500) {
    super(message);
  }
}

export async function runPanelOp(
  app: PanelAppRef,
  op: string,
  params: Record<string, unknown> = {},
): Promise<PanelResult> {
  try {
    switch (op as PanelOp) {
      case 'mcpl':
        return { ok: true, data: buildMcplSnapshot(app) };
      case 'tool-classes':
        return {
          ok: true,
          data: buildToolClassesSnapshot(
            app,
            typeof params.agent === 'string' && params.agent.length > 0 ? params.agent : undefined,
          ),
        };
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
        if (!removed) data.warning = `no such pin: ${String(params.pinId ?? '')}`;
        return { ok: true, data };
      }
      case 'health':
        return { ok: true, data: buildHealthSnapshot(app) };
      case 'quota':
        return { ok: true, data: await buildQuotaSnapshot(app) };
      case 'credential':
        return { ok: true, data: buildCredentialSnapshot(app) };
      case 'credential-action':
        return { ok: true, data: await applyCredentialAction(app, params) };
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
      case 'media':
        return { ok: true, data: buildMediaBlock(app, resolveAgent(app, params.agent), params) };
      default:
        return { ok: false, error: `unknown panel op: ${op}`, status: 400 };
    }
  } catch (err) {
    if (err instanceof PanelError) return { ok: false, error: err.message, status: err.status };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function resolveAgent(app: PanelAppRef, name?: unknown): string {
  if (typeof name === 'string' && name.length > 0) return name;
  return app.recipe.agent.name ?? app.framework.getAllAgents()[0]?.name ?? 'agent';
}

function requireAgent(app: PanelAppRef, agentName: string): NonNullable<ReturnType<AgentFramework['getAgent']>> {
  const agent = app.framework.getAgent(agentName);
  if (!agent) throw new PanelError(`Agent not found: ${agentName}`, 404);
  return agent;
}

interface MediaReadableCm {
  getMessage(id: never): { content?: ReadonlyArray<unknown> } | null;
  getMessageCount(): number;
  getMessageWindow(
    offset: number,
    limit: number,
    opts?: { resolveBlobs?: boolean },
  ): { messages: Array<{ id?: unknown; content?: ReadonlyArray<unknown> }>; startIndex: number };
}

const MEDIA_SCAN_WINDOW = 500;

function readInflatedContent(cm: MediaReadableCm, messageId: string): ReadonlyArray<unknown> | null {
  const direct = cm.getMessage(messageId as never);
  if (!direct) return null;
  const content = direct.content ?? [];
  const hasBlobRef = content.some((b) => (b as { type?: string } | null)?.type === 'blob_ref');
  if (!hasBlobRef) return content;
  const total = cm.getMessageCount();
  for (let end = total; end > 0; end -= MEDIA_SCAN_WINDOW) {
    const start = Math.max(0, end - MEDIA_SCAN_WINDOW);
    const win = cm.getMessageWindow(start, end - start, { resolveBlobs: false });
    const k = win.messages.findIndex((m) => String(m.id) === messageId);
    if (k >= 0) {
      return cm.getMessageWindow(win.startIndex + k, 1, { resolveBlobs: true }).messages[0]?.content ?? content;
    }
  }
  return content;
}

export function buildMediaBlock(
  app: PanelAppRef,
  agentName: string,
  params: Record<string, unknown>,
): { mediaType: string; base64: string } {
  const agent = requireAgent(app, agentName);
  const messageId = typeof params.messageId === 'string' ? params.messageId : '';
  const path = typeof params.path === 'string' ? params.path : '';
  if (!messageId || !/^\d{1,4}(\.\d{1,4})?$/.test(path)) {
    throw new PanelError('media: messageId and block path (<n> or <n>.<m>) are required', 400);
  }
  const cm = agent.getContextManager() as unknown as MediaReadableCm;
  const content = readInflatedContent(cm, messageId);
  if (!content) throw new PanelError(`message not found on the active branch: ${messageId}`, 404);
  const [outer, inner] = path.split('.').map(Number);
  let block = content[outer] as Record<string, unknown> | undefined;
  if (inner !== undefined) {
    const nested = block?.type === 'tool_result' && Array.isArray(block.content) ? block.content : null;
    block = nested ? (nested[inner] as Record<string, unknown> | undefined) : undefined;
  }
  const b = block as
    | { type?: string; source?: { type?: string; data?: unknown; mediaType?: unknown } }
    | undefined;
  if (!b || b.type !== 'image') throw new PanelError(`no image block at ${path}`, 404);
  const src = b.source;
  if (src?.type !== 'base64' || typeof src.data !== 'string' || typeof src.mediaType !== 'string') {
    throw new PanelError('image is not inline (reference-only or stripped)', 404);
  }
  if (!src.mediaType.startsWith('image/')) throw new PanelError(`not an image media type: ${src.mediaType}`, 415);
  return { mediaType: src.mediaType, base64: src.data };
}

export interface McplLiveServer {
  id: string;
  connected: boolean;
  toolCount: number;
  toolPrefix?: string;
  target?: string;
  closedTab?: boolean;
}

export function buildMcplSnapshot(app: PanelAppRef): Record<string, unknown> {
  let servers: ReturnType<typeof readMcplServersFile> = {};
  try { servers = readMcplServersFile(DEFAULT_CONFIG_PATH); }
  catch { }

  let live: McplLiveServer[] = [];
  try {
    const fw = app.framework as unknown as {
      listMcplServers?: () => Array<{
        id: string; connected?: boolean; toolCount?: number; toolPrefix?: string;
        command?: string; url?: string; closedTab?: boolean;
      }>;
    };
    if (typeof fw.listMcplServers === 'function') {
      live = fw.listMcplServers().map((s) => ({
        id: s.id,
        connected: s.connected === true,
        toolCount: s.toolCount ?? 0,
        ...(s.toolPrefix ? { toolPrefix: s.toolPrefix } : {}),
        ...(s.command || s.url ? { target: s.command ?? s.url } : {}),
        ...(s.closedTab ? { closedTab: true } : {}),
      }));
    }
  } catch { }

  let toolClasses: ToolClassRow[] | null = null;
  try { toolClasses = readToolClasses(app.framework); }
  catch { }

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
    ...(toolClasses ? { toolClasses } : {}),
  };
}

export interface ToolClassesSnapshot {
  /** The agent whose surface this is, or null for every tool offered. */
  agent: string | null;
  /** Rows per source: override / host / server / none (unclassed). */
  counts: Record<ToolClassSource, number>;
  /** Sorted by tool name. */
  tools: ToolClassRow[];
}

/**
 * Each tool with its effective class and the source that decided it. Unlike
 * the agent-scoped panels, omitting `agent` does not default to the primary
 * agent: it lists every tool the framework offers to anyone (the shared
 * board plus agent-only surfaces such as the subconscious's).
 */
export function buildToolClassesSnapshot(app: PanelAppRef, agent?: string): ToolClassesSnapshot {
  if (agent !== undefined) requireAgent(app, agent);
  const tools = readToolClasses(app.framework, agent);
  if (tools === null) {
    throw new PanelError('this agent-framework build does not report tool classes', 501);
  }
  return { agent: agent ?? null, counts: countToolClassSources(tools), tools };
}

export interface SettingsStateData {
  agent: string;
  settings: Record<string, unknown>;
  overrides: string[];
  hotKeys: string[];
  hotConfigurable: boolean;
  previewAvailable: boolean;
}

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

  // context-manager answers getHotContextSettings() with null for a
  // strategy without hot settings: the hot set is the active strategy's.
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
  } catch { }

  const overrides: string[] = [];
  try {
    const agent = app.framework.getAgent(agentName) as unknown as {
      getRuntimeSettingsOverrides?: () => Record<string, unknown>;
    } | undefined;
    const ov = agent?.getRuntimeSettingsOverrides?.() ?? {};
    for (const [k, val] of Object.entries(ov)) if (val !== undefined) overrides.push(k);
  } catch { }

  return {
    agent: agentName,
    settings,
    overrides,
    // agent-framework applies contextBudgetTokens itself, and passes
    // tailTokens and transitionPaceTokens to the strategy's hot settings.
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
    console.warn('[settings] notify failed (change still applied):', err);
  }
}

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
  candidates?: Array<{ id: string; index: number; participant: string; text: string }>;
}

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

const PIN_CANDIDATE_LIMIT = 200;
const PIN_CANDIDATE_TEXT_CAP = 160;

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
  } catch { }

  return {
    agent: agentName,
    pins,
    pinsSupported: supported,
    levelHonored,
    ...(deepestLevel !== undefined ? { deepestLevel } : {}),
    ...(opts.withCandidates ? { candidates: buildPinCandidates(app, agentName) } : {}),
  };
}

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
    cm.pinRange!(firstMessageId, String(params.lastMessageId ?? firstMessageId), opts);
  }
}

export function applyPinRemove(app: PanelAppRef, agentName: string, pinId: string): boolean {
  const cm = pinnableCm(app, agentName);
  if (!pinId) throw new PanelError('pinId required', 400);
  return cm.unpin!(pinId);
}

function hostHoldActive(app: PanelAppRef): boolean | null {
  const fw = app.framework as unknown as { healthSnapshot?: () => { agents?: unknown } };
  if (typeof fw.healthSnapshot !== 'function') return null;
  try {
    const agents = fw.healthSnapshot().agents;
    if (!Array.isArray(agents)) return null;
    const flags = agents.map((a) => (a as { providerAdmission?: { hostHold?: unknown } }).providerAdmission?.hostHold);
    if (!flags.some((f) => typeof f === 'boolean')) return null;
    return flags.some((f) => f === true);
  } catch {
    return null;
  }
}

export async function buildQuotaSnapshot(app: PanelAppRef): Promise<Record<string, unknown>> {
  if (!app.quotaMeter) return { subscription: app.subscriptionUnmetered === true, windows: [] };
  const snapshot = await app.quotaMeter.refresh();
  return {
    subscription: true,
    provider: app.quotaMeter.provider,
    windows: snapshot?.windows ?? [],
    fetchedAt: snapshot?.fetchedAt ?? 0,
    ...(snapshot?.error !== undefined ? { error: snapshot.error } : {}),
    blockedUntil: app.quotaMeter.blockedUntil(app.recipe.agent.model) ?? null,
    parked: hostHoldActive(app),
  };
}

export function buildCredentialSnapshot(app: PanelAppRef): Record<string, unknown> {
  if (!app.credentials) return { subscription: false };
  return { subscription: true, agent: resolveAgent(app), ...app.credentials.snapshot() };
}

const CREDENTIAL_ACTIONS: ReadonlySet<string> = new Set(['refresh', 'login', 'set-token', 'recheck']);

export async function applyCredentialAction(app: PanelAppRef, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!app.credentials) throw new PanelError('this host runs on an API key; no credential actions', 404);
  const action = typeof params.action === 'string' ? params.action : '';
  if (!CREDENTIAL_ACTIONS.has(action)) throw new PanelError(`unknown credential action: ${action || '(none)'}`, 400);
  const token = typeof params.token === 'string' ? params.token : undefined;
  if (action === 'set-token' && !token?.trim()) throw new PanelError('set-token needs a token', 400);
  const state = await app.credentials.runAction(action as CredentialActionId, token !== undefined ? { token } : {});
  return { subscription: true, agent: resolveAgent(app), ...state };
}

type FrameworkAgent = ReturnType<AgentFramework['getAllAgents']>[number];

const READ_FAILURE_MAX_CHARS = 300;
const READ_FAILURE_UNDESCRIBED = "the read failed, and its error couldn't be described";

function describeReadFailure(error: unknown): string {
  try {
    const message = typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : String(error);
    if (typeof message === 'string' && message.length > 0) {
      let kept = '';
      let count = 0;
      for (const codePoint of message) {
        if (count++ === READ_FAILURE_MAX_CHARS) break;
        kept += codePoint;
      }
      return kept;
    }
  } catch {
  }
  return READ_FAILURE_UNDESCRIBED;
}

function perAgentHealth(
  app: PanelAppRef,
  section: string,
  failures: Record<string, Record<string, string>>,
  read: (agent: FrameworkAgent, name: string) => unknown,
): Record<string, unknown> {
  const entries: Record<string, unknown> = Object.create(null);
  for (const agent of app.framework.getAllAgents()) {
    const name = (agent as unknown as { name: string }).name;
    try {
      const value = read(agent, name);
      if (value) entries[name] = value;
    } catch (error) {
      (failures[name] ??= {})[section] = describeReadFailure(error);
    }
  }
  return entries;
}

/**
 * The /healthz answer: agent-framework's healthSnapshot, with `credential`
 * on a host with a credential monitor; by agent, compressionQuarantine,
 * compressionDebt, loadRepair, contextComposition and runtimeSettings, and
 * readFailures naming the reads that threw; `callLedger` when a ledger is
 * wired; and `update`. Every read is cheap: no compile, no count_tokens.
 */
export function buildHealthSnapshot(app: PanelAppRef): Record<string, unknown> {
  const fw = app.framework as unknown as { healthSnapshot?: () => Record<string, unknown> };
  if (typeof fw.healthSnapshot !== 'function') {
    throw new PanelError('framework lacks healthSnapshot()', 501);
  }
  const snapshot = fw.healthSnapshot();
  // readFailures, when a read threw: by agent, then by section, what it threw
  // (its message cut to 300 code points, or a fixed text when it has none).
  // That agent is left out of the section, as one with nothing to report is.
  const readFailures: Record<string, Record<string, string>> = Object.create(null);
  // credential: the monitor's CredentialState, which holds no token, with
  // `agent`, the name the host's alerts carry.
  try {
    if (app.credentials) {
      (snapshot as Record<string, unknown>).credential = { agent: resolveAgent(app), ...app.credentials.snapshot() };
    }
  } catch {
  }
  // compressionQuarantine: each agent's compression quarantine, as its
  // strategy reports it.
  try {
    (snapshot as Record<string, unknown>).compressionQuarantine = perAgentHealth(app, 'compressionQuarantine', readFailures, (agent) =>
      (agent.getContextManager() as unknown as {
        getStrategy?: () => { getCompressionQuarantineStatus?: () => unknown };
      }).getStrategy?.()?.getCompressionQuarantineStatus?.());
  } catch {
  }
  // compressionDebt: each agent's compression debt as context-manager
  // reduces it, healthy, degraded, critical or unknown, with the numbers
  // behind it.
  try {
    (snapshot as Record<string, unknown>).compressionDebt = perAgentHealth(app, 'compressionDebt', readFailures, (agent) =>
      (agent.getContextManager() as unknown as {
        getStrategy?: () => { getCompressionDebt?: () => unknown };
      }).getStrategy?.()?.getCompressionDebt?.());
  } catch {
  }
  // loadRepair: each agent's newest load-repair report, which its strategy
  // keeps for its life, so a session switch starts it fresh; absent while
  // it has made none.
  try {
    (snapshot as Record<string, unknown>).loadRepair = perAgentHealth(app, 'loadRepair', readFailures, (agent) =>
      (agent.getContextManager() as unknown as {
        getStrategy?: () => { getLatestLoadRepairReport?: () => unknown };
      }).getStrategy?.()?.getLatestLoadRepairReport?.());
  } catch {
  }
  // contextComposition: each agent's render stats from its last live
  // compile. An agent with none is left out, and contextCompositionNotKept,
  // left out when empty, names those whose strategy keeps none.
  try {
    const notKept: string[] = [];
    (snapshot as Record<string, unknown>).contextComposition = perAgentHealth(app, 'contextComposition', readFailures, (agent, name) => {
      const cm = agent.getContextManager() as unknown as { getRenderStats?: () => unknown };
      const stats = cm.getRenderStats?.();
      if (stats == null && !keepsRenderStats(cm)) notKept.push(name);
      return stats;
    });
    if (notKept.length > 0) (snapshot as Record<string, unknown>).contextCompositionNotKept = notKept;
  } catch {
  }
  // runtimeSettings: each agent's runtime settings, the core of what
  // `agent_settings get` returns.
  try {
    const fw2 = app.framework as unknown as {
      getAgentRuntimeSettings?: (name: string) => unknown;
    };
    const getSettings = fw2.getAgentRuntimeSettings;
    if (typeof getSettings === 'function') {
      (snapshot as Record<string, unknown>).runtimeSettings = perAgentHealth(app, 'runtimeSettings', readFailures, (agent) =>
        getSettings.call(app.framework, (agent as unknown as { name: string }).name));
    }
  } catch {
  }
  if (Object.keys(readFailures).length > 0) {
    (snapshot as Record<string, unknown>).readFailures = readFailures;
  }
  // callLedger: recent provider calls, when the host wired a ledger.
  try {
    const ledger = app.callLedger?.snapshot();
    if (ledger) (snapshot as Record<string, unknown>).callLedger = ledger;
  } catch {
  }
  // update: the host's update status, absent before main() sets it up.
  try {
    (snapshot as Record<string, unknown>).update = hostUpdate.status();
  } catch {
  }
  return snapshot;
}

export function buildContextMaintenance(app: PanelAppRef): Record<string, unknown> {
  const framework = app.framework as unknown as {
    getContextMaintenanceSnapshot?: () => Record<string, unknown>;
  };
  if (typeof framework.getContextMaintenanceSnapshot !== 'function') {
    throw new PanelError('framework lacks context-maintenance diagnostics', 501);
  }
  return framework.getContextMaintenanceSnapshot();
}

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

export interface CountablePreview {
  system?: string | ContentBlock[];
  messages?: NormalizedMessage[];
  tools?: ToolDefinition[];
  config?: { thinking?: { enabled: boolean; budgetTokens?: number } };
  prefillUserMessage?: NormalizedRequest['prefillUserMessage'];
}

export interface CountTokensPayload {
  system?: unknown;
  messages: unknown[];
  tools?: unknown[];
}

export type CountFormatter = Pick<NativeFormatter, 'buildMessages'>;

export function buildCountTokensPayload(
  preview: CountablePreview,
  agentName: string,
  formatter: CountFormatter = new NativeFormatter(),
  toolMode: 'native' | 'xml' = 'native',
  anthropicServerBlocks = false,
): CountTokensPayload {
  const built = formatter.buildMessages(preview.messages ?? [], {
    participantMode: 'multiuser',
    assistantParticipant: agentName,
    tools: preview.tools,
    toolMode,
    thinking: preview.config?.thinking,
    systemPrompt: preview.system,
    // Inference passes the agent's prefill message to the formatter, which
    // for anthropic-xml sends it first, in place of its default opener,
    // whenever the request would otherwise open with the assistant's turn;
    // without it the count would have that default in its place.
    ...(preview.prefillUserMessage ? { prefillUserMessage: preview.prefillUserMessage } : {}),
    promptCaching: false,
    cacheMarkers: 'membrane-system',
    anthropicServerBlocks,
  });
  const tools = Array.isArray(built.nativeTools) ? built.nativeTools : undefined;
  const system = built.systemContent;
  return {
    ...(system !== undefined && system !== null && system !== '' && !(Array.isArray(system) && system.length === 0)
      ? { system }
      : {}),
    messages: built.messages as unknown[],
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
}

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

/** Whether a context manager's strategy keeps render stats, as
 *  context-manager's isRenderStatsCapable asks (its root doesn't export
 *  it): one without getRenderStats, such as PassthroughStrategy, has
 *  getRenderStats() null for good. */
function keepsRenderStats(cm: unknown): boolean {
  const strategy = (cm as { getStrategy?: () => unknown }).getStrategy?.();
  return typeof (strategy as { getRenderStats?: unknown } | undefined)?.getRenderStats === 'function';
}

/**
 * The /debug/context/makeup answer: `stats`, the render stats of the
 * agent's last live compile (head, raw middle, summaries by level, tail),
 * and an exact count of the next request as the default preview builds it,
 * without what modules add at each turn. The preview's compile is a dry
 * run, which leaves the render stats as they were, so `stats` is null
 * until a live compile has run since the strategy loaded its branch, and
 * for good where the strategy keeps none, which `statsKept` tells apart.
 */
export async function buildContextMakeup(app: PanelAppRef, agentName: string): Promise<Record<string, unknown>> {
  const agent = requireAgent(app, agentName);
  const request = await app.framework.previewActivation(agentName);
  const cm = (agent as unknown as { getContextManager: () => { getRenderStats: () => unknown } }).getContextManager();
  const stats = cm.getRenderStats();
  const statsKept = keepsRenderStats(cm);

  const xml = app.recipe.agent.formatter === 'anthropic-xml';
  const primaryAgentModel = () => requireAgent(app, resolveAgent(app)).model;
  const payload = buildCountTokensPayload(
    request as unknown as CountablePreview,
    agentName,
    xml ? anthropicXmlFormatter({ toolsInSystem: xmlToolsInSystem(app.recipe, primaryAgentModel()) }) : new NativeFormatter(),
    xml ? 'xml' : 'native',
    // membrane replays an assistant turn's server-tool blocks only through an
    // adapter that declares replaysAnthropicServerBlocks, which of its
    // adapters only AnthropicAdapter does: the host's for provider anthropic.
    resolveProvider(app.recipe) === 'anthropic',
  );
  // lastBilledInputTokens: what the provider billed for the input of the
  // latest call on the agent's stream that reported one (fresh + cache read
  // + cache creation); null from a stream's start until a call reports one.
  const lastBilledInputTokens =
    (agent as { lastStreamRealInputTokens?: number }).lastStreamRealInputTokens || null;

  let exactTotalTokens: number | null = null;
  // COUNT_TOKENS_MODEL, when set, is the model counted against in place of
  // the agent's own.
  const countModel = process.env.COUNT_TOKENS_MODEL
    || anthropicCountModel((agent as { model?: string }).model);
  let countSource = 'count_tokens';
  if (!countModel) {
    return { agent: agentName, stats, statsKept, exactTotalTokens, lastBilledInputTokens, countModel, countSource: 'count_tokens_unsupported_model' };
  }
  try {
    const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    const res = await fetch(base + '/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        ...((app.credentials?.bearer() ?? process.env.ANTHROPIC_AUTH_TOKEN)
          ? {
              authorization: `Bearer ${app.credentials?.bearer() ?? process.env.ANTHROPIC_AUTH_TOKEN}`,
              'anthropic-beta': 'oauth-2025-04-20',
            }
          : { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '' }),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'user-agent': 'conhost/1.0',
      },
      body: JSON.stringify({ model: countModel, ...payload }),
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

  return { agent: agentName, stats, statsKept, exactTotalTokens, lastBilledInputTokens, countModel, countSource };
}

/**
 * A feasibility preview's accounting, against the budget asked for.
 * context-manager's `budgetTokens` is the hard budget a compile throws
 * past, its over-budget grace included, and its `fits` means under that,
 * not under the budget asked for.
 */
function previewAccounting(result: unknown, budget: number, reserve: number) {
  const r = result as { finalTokens?: number; budgetTokens?: number; exhausted?: boolean };
  const effectiveBudget = Math.max(0, budget - reserve);
  const finalTokens = typeof r.finalTokens === 'number' ? r.finalTokens : NaN;
  const fitsRequested = Number.isFinite(finalTokens) && finalTokens <= effectiveBudget;
  const withinGrace = Number.isFinite(finalTokens) && typeof r.budgetTokens === 'number'
    ? finalTokens <= r.budgetTokens
    : undefined;
  return {
    requestedBudgetTokens: budget,
    reserveForResponseTokens: reserve,
    /** The picker's planned total, when the preview reports one. */
    plannedTokens: Number.isFinite(finalTokens) ? finalTokens : null,
    /** What the picker actually targets. */
    effectiveBudgetTokens: effectiveBudget,
    /** Hard-fail ceiling — requested minus reserve, plus grace. */
    rejectionBudgetTokens: r.budgetTokens,
    /** Fits the budget the operator asked for. */
    fitsRequested,
    /** Within the hard budget, so no compile throws for its size: true as
     *  well when it fits the request. */
    withinGrace,
    /** Exhausted AND over the request => this budget is UNREACHABLE. */
    unreachable: r.exhausted === true && !fitsRequested,
  };
}

/**
 * Whether the curve's plan fits, from the framework's feasibility preview,
 * with the settings panel's accounting; null when the preview is
 * unavailable (no previewContextSettings, or a strategy without a fold
 * plan) or throws. During a paced budget descent (`transition` other than
 * `stable`) the curve and its verdict are at the descent's target, while
 * compiles run at the live budget: `atDescentTarget` says so.
 */
function curveVerdict(
  app: PanelAppRef,
  agentName: string,
  maxTokens: number,
  reserveForResponse: number,
  transition: string | undefined,
): Record<string, unknown> | null {
  try {
    const fw = app.framework as unknown as {
      previewContextSettings?: (name: string, budget: number) => unknown;
    };
    const r = fw.previewContextSettings?.(agentName, maxTokens);
    if (!r) return null;
    const { plannedTokens, effectiveBudgetTokens, rejectionBudgetTokens, fitsRequested, withinGrace, unreachable } =
      previewAccounting(r, maxTokens, reserveForResponse);
    return {
      plannedTokens,
      effectiveBudgetTokens,
      rejectionBudgetTokens: rejectionBudgetTokens ?? null,
      fitsRequested,
      withinGrace,
      unreachable,
      atDescentTarget: transition !== undefined && transition !== 'stable',
    };
  } catch {
    return null;
  }
}

/**
 * The /debug/context/curve answer: one record per compiled entry with its
 * provenance: kind (raw, or an L1..Ln summary), rendered token estimate,
 * the raw-history tokens it covers (leaf messages, through the summary
 * tree), date span and full text. The budget is the agent's context budget
 * from its runtime settings (else the recipe's), with the recipe's
 * response reserve.
 *
 * A render runs two dry selects, the curve's compile and the verdict's
 * preview, each pausing the agent while it runs; the settings preview's
 * cooldown isn't applied. A dry run commits no fold resolutions, queues no
 * compression, and leaves the hot settings, calibration and render stats
 * as the last committing compile left them; as any compile does, it
 * releases a compression hold whose deadline has passed. It skips only
 * context-manager's post-pick check, so a plan over budget there is
 * plotted beside the verdict, while a budget the context can't fit at all
 * still throws. No inference of its own, no message writes.
 */
export async function buildContextCurve(app: PanelAppRef, agentName: string): Promise<Record<string, unknown>> {
  requireAgent(app, agentName);
  const agent = app.framework.getAgent(agentName)!;
  const cm = (agent as unknown as { getContextManager: () => any }).getContextManager();
  let maxTokens = effectiveContextBudgetTokens(app.recipe, recipeModel(app.recipe, process.env.MODEL));
  let transition: string | undefined;
  try {
    const settings = (app.framework as unknown as {
      getAgentRuntimeSettings?: (n: string) => { contextBudgetTokens?: number; transition?: string };
    }).getAgentRuntimeSettings?.(agentName);
    const live = settings?.contextBudgetTokens;
    if (typeof live === 'number' && live > 0) maxTokens = live;
    transition = settings?.transition;
  } catch { }
  const reserveForResponse = effectiveMaxTokens(app.recipe);
  // A dry run: a committing compile on every render would persist its fold
  // resolutions and queue compression from its plan, mid-stream included.
  const compiled = await cm.compile({ maxTokens, reserveForResponse }, undefined, { dryRun: true });
  const verdict = curveVerdict(app, agentName, maxTokens, reserveForResponse, transition);

  // The curve needs only text and metadata, and context-manager's reads
  // re-inline blob media unless told resolveBlobs: false.
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
      // The store gives each timestamp as a Date, which sort's default orders
      // by its text, weekday first.
      const times = leafIds.map((id) => msgById.get(id)!.timestamp)
        .filter((t) => t !== undefined && t !== null)
        .map((t) => new Date(t as Date | string | number).getTime())
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b);
      entries.push({
        i: i++, kind: `L${sum.level}`, id: sum.id, participant: e.participant,
        rendered, rawCovered, msgCount: leafIds.length, nImages,
        dateFirst: times.length > 0 ? new Date(times[0]) : null,
        dateLast: times.length > 0 ? new Date(times[times.length - 1]) : null, text,
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
    verdict,
    totals: {
      entries: entries.length,
      rendered: entries.reduce((a, e) => a + e.rendered, 0),
      rawCovered: entries.reduce((a, e) => a + e.rawCovered, 0),
    },
    entries,
  };
}

let previewInFlight = false;
let previewLastAt = 0;
const PREVIEW_COOLDOWN_MS = 3_000;

/** With render=1, the dry run's entries come back as a compact projection:
 *  identity, size and a bounded text preview, with no content blocks or
 *  inline media. */
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
 * The /debug/context/preview answer: the fold plan at a hypothetical budget
 * and tail, committing nothing. A budget that can't work is reported in the
 * diagnostics, not as an error.
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
    const reserve = effectiveMaxTokens(app.recipe);
    return {
      agent: agentName,
      budget,
      ...(overrides as object),
      accounting: previewAccounting(result, budget, reserve),
      /** How long the preview's compile took; the agent is paused at least
       *  this long. */
      elapsedMs: Date.now() - startedAt,
      preview: wantRender ? projectDryEntries(result) : result,
    };
  } finally {
    previewInFlight = false;
    previewLastAt = Date.now();
  }
}

export async function buildDebugContext(
  app: PanelAppRef,
  agentName: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  requireAgent(app, agentName);
  const injections = params.injections === true;
  const request = await app.framework.previewActivation(agentName, { injections });
  // The presentation captured with this request, or null for an agent without one.
  return { agent: agentName, injections, transparent: !injections, request,
    toolPresentation: app.framework.getRequestToolPresentation(request) };
}
