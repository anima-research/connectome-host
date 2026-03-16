/**
 * WakeModule — file-driven MCPL event triggering with per-policy debounce.
 *
 * Reads policies from a `wake.json` config file. The recipe seeds this file
 * on first run; after that the agent owns it and can edit it with file tools.
 *
 * Policies are evaluated in order — first match wins. Each policy specifies
 * a behavior: "always" (trigger immediately), "suppress" (drop), or
 * { "debounce": ms } (batch events per-policy, deliver when timer fires).
 *
 * Exposes `shouldTrigger` for wiring into McplServerConfig.shouldTriggerInference.
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  TraceEvent,
} from '@connectome/agent-framework';
import type { AgentFramework } from '@connectome/agent-framework';

// ---------------------------------------------------------------------------
// Types — Wake Config (persisted as wake.json)
// ---------------------------------------------------------------------------

export interface WakeConfig {
  policies: WakePolicy[];
  /** What happens when no policy matches. Default: 'always' */
  default: 'always' | 'suppress';
}

export interface WakePolicy {
  name: string;
  match: WakePolicyMatch;
  behavior: 'always' | 'suppress' | { debounce: number };
}

export interface WakePolicyMatch {
  /** Event types to match: 'channel:incoming', 'push:event', etc. Empty/omitted = all. */
  scope?: string[];
  /** ServerId to match (exact or glob with *). */
  source?: string;
  /** ChannelId to match (exact or glob with *). */
  channel?: string;
  /** Content text filter. */
  filter?: { type: 'text' | 'regex'; pattern: string };
}

/** Default config when no recipe wake config and no existing file. */
export const DEFAULT_WAKE_CONFIG: WakeConfig = {
  policies: [],
  default: 'always',
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max content length stored in pending events. */
const MAX_CONTENT_SNIPPET = 200;
/** Max content length shown in onWake callbacks. */
const MAX_WAKE_SNIPPET = 80;
/** Max events buffered during inference before oldest are dropped. */
const MAX_INFERENCE_BUFFER = 100;
/** Minimum interval between filesystem checks for config changes (ms). */
const RELOAD_THROTTLE_MS = 1000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingEvent {
  policyName: string;
  content: string;
  eventType: string;
  timestamp: number;
}

interface DebounceState {
  timer: ReturnType<typeof setTimeout>;
  events: PendingEvent[];
}

/** A compiled policy with pre-built matchers for fast evaluation. */
interface CompiledPolicy {
  policy: WakePolicy;
  filterRegex?: RegExp;
  sourceRegex?: RegExp;
  channelRegex?: RegExp;
}

// ---------------------------------------------------------------------------
// Glob matching (simple * wildcards)
// ---------------------------------------------------------------------------

function compileGlob(pattern: string): RegExp {
  if (!pattern.includes('*')) {
    return new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&') + '$');
  }
  return new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  );
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class WakeModule implements Module {
  readonly name = 'wake';

  private ctx: ModuleContext | null = null;
  private configPath: string;
  private config: WakeConfig;
  private compiledPolicies: CompiledPolicy[] = [];
  private configMtime: number = 0;
  private lastReloadCheck: number = 0;

  private inferring = false;
  private inferenceBuffer: PendingEvent[] = [];
  private debounceTimers = new Map<string, DebounceState>();

  private agentName: string;
  private onWake?: (policyNames: string[], summary: string) => void;

  constructor(opts: {
    configPath: string;
    agentName?: string;
    onWake?: (policyNames: string[], summary: string) => void;
  }) {
    this.configPath = opts.configPath;
    this.agentName = opts.agentName ?? 'agent';
    this.onWake = opts.onWake;
    this.config = this.loadConfig();
    this.compiledPolicies = this.compilePolicies(this.config);
  }

  setFramework(framework: AgentFramework): void {
    framework.onTrace((event: TraceEvent) => {
      const agent = 'agentName' in event ? (event as { agentName: string }).agentName : null;
      if (agent !== this.agentName) return;

      if (event.type === 'inference:started') {
        this.inferring = true;
      } else if (event.type === 'inference:completed' || event.type === 'inference:failed') {
        this.inferring = false;
        // Defer flush to avoid pushEvent re-entrancy inside trace callback
        queueMicrotask(() => this.flushInferenceBuffer());
      }
    });
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.ctx = null;
    // Clear all debounce timers
    for (const state of this.debounceTimers.values()) {
      clearTimeout(state.timer);
    }
    this.debounceTimers.clear();
  }

  // =========================================================================
  // Config loading (file-based, reloaded when mtime changes)
  // =========================================================================

  private loadConfig(): WakeConfig {
    if (!existsSync(this.configPath)) {
      return { ...DEFAULT_WAKE_CONFIG };
    }
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const stat = statSync(this.configPath);
      this.configMtime = stat.mtimeMs;
      return validateWakeConfig(JSON.parse(raw));
    } catch (err) {
      console.error(`[wake] Failed to load ${this.configPath}:`, err);
      return { ...DEFAULT_WAKE_CONFIG };
    }
  }

  private compilePolicies(config: WakeConfig): CompiledPolicy[] {
    return config.policies.map(policy => {
      const compiled: CompiledPolicy = { policy };
      if (policy.match.filter?.type === 'regex') {
        try { compiled.filterRegex = new RegExp(policy.match.filter.pattern, 'i'); } catch { /* skip */ }
      }
      if (policy.match.source) {
        compiled.sourceRegex = compileGlob(policy.match.source);
      }
      if (policy.match.channel) {
        compiled.channelRegex = compileGlob(policy.match.channel);
      }
      return compiled;
    });
  }

  private reloadIfChanged(): void {
    const now = Date.now();
    if (now - this.lastReloadCheck < RELOAD_THROTTLE_MS) return;
    this.lastReloadCheck = now;

    try {
      if (!existsSync(this.configPath)) return;
      const stat = statSync(this.configPath);
      if (stat.mtimeMs !== this.configMtime) {
        this.config = this.loadConfig();
        this.compiledPolicies = this.compilePolicies(this.config);
      }
    } catch {
      // ignore stat errors
    }
  }

  // =========================================================================
  // shouldTrigger — arrow method for stable `this` binding
  // =========================================================================

  shouldTrigger = (content: string, metadata: Record<string, unknown>): boolean => {
    this.reloadIfChanged();

    const eventType = (metadata.eventType as string) ?? 'unknown';
    const serverId = (metadata.serverId as string) ?? '';
    const channelId = (metadata.channelId as string) ?? '';

    const policy = this.matchPolicy(content, eventType, serverId, channelId);

    if (!policy) {
      // No policy matched — use default
      return this.config.default === 'always';
    }

    if (policy.behavior === 'suppress') {
      return false;
    }

    if (policy.behavior === 'always') {
      return this.handleAlways(policy, content, eventType);
    }

    // Debounce behavior
    this.handleDebounce(policy, content, eventType);
    return false; // Never trigger immediately for debounce — the timer will deliver
  };

  // =========================================================================
  // Policy matching — first match wins
  // =========================================================================

  private matchPolicy(
    content: string,
    eventType: string,
    serverId: string,
    channelId: string,
  ): WakePolicy | null {
    for (const compiled of this.compiledPolicies) {
      if (this.compiledMatches(compiled, content, eventType, serverId, channelId)) {
        return compiled.policy;
      }
    }
    return null;
  }

  private compiledMatches(
    compiled: CompiledPolicy,
    content: string,
    eventType: string,
    serverId: string,
    channelId: string,
  ): boolean {
    const match = compiled.policy.match;

    // Scope check
    if (match.scope && match.scope.length > 0 && !match.scope.includes(eventType)) {
      return false;
    }

    // Source check (serverId) — uses pre-compiled regex
    if (compiled.sourceRegex && !compiled.sourceRegex.test(serverId)) {
      return false;
    }

    // Channel check — uses pre-compiled regex
    if (compiled.channelRegex && !compiled.channelRegex.test(channelId)) {
      return false;
    }

    // Content filter check
    if (match.filter) {
      if (match.filter.type === 'text') {
        if (!content.toLowerCase().includes(match.filter.pattern.toLowerCase())) {
          return false;
        }
      } else if (compiled.filterRegex) {
        if (!compiled.filterRegex.test(content)) {
          return false;
        }
      } else {
        return false; // Regex failed to compile — no match
      }
    }

    return true;
  }

  // =========================================================================
  // Behavior handlers
  // =========================================================================

  private snippetContent(content: string): string {
    return content.length > MAX_CONTENT_SNIPPET ? content.slice(0, MAX_CONTENT_SNIPPET) + '...' : content;
  }

  private bufferEvent(policyName: string, content: string, eventType: string): void {
    if (this.inferenceBuffer.length >= MAX_INFERENCE_BUFFER) {
      // Drop oldest to prevent unbounded growth
      this.inferenceBuffer.shift();
    }
    this.inferenceBuffer.push({
      policyName,
      content: this.snippetContent(content),
      eventType,
      timestamp: Date.now(),
    });
  }

  private handleAlways(policy: WakePolicy, content: string, eventType: string): boolean {
    // If currently inferring, buffer it (same as old behavior)
    if (this.inferring) {
      this.bufferEvent(policy.name, content, eventType);
      return false;
    }

    if (this.onWake) {
      const snippet = content.length > MAX_WAKE_SNIPPET ? content.slice(0, MAX_WAKE_SNIPPET) + '...' : content;
      this.onWake([policy.name], snippet);
    }
    return true;
  }

  private handleDebounce(policy: WakePolicy, content: string, eventType: string): void {
    const debounceMs = (policy.behavior as { debounce: number }).debounce;

    const event: PendingEvent = {
      policyName: policy.name,
      content: this.snippetContent(content),
      eventType,
      timestamp: Date.now(),
    };

    const existing = this.debounceTimers.get(policy.name);
    if (existing) {
      // Reset timer, add event to batch
      clearTimeout(existing.timer);
      existing.events.push(event);
      existing.timer = setTimeout(() => this.fireDebounce(policy.name), debounceMs);
    } else {
      // Start new debounce window
      const timer = setTimeout(() => this.fireDebounce(policy.name), debounceMs);
      this.debounceTimers.set(policy.name, { timer, events: [event] });
    }
  }

  private fireDebounce(policyName: string): void {
    const state = this.debounceTimers.get(policyName);
    if (!state || state.events.length === 0) {
      this.debounceTimers.delete(policyName);
      return;
    }

    const events = state.events;
    this.debounceTimers.delete(policyName);

    // If currently inferring, move to inference buffer instead
    if (this.inferring) {
      this.inferenceBuffer.push(...events);
      return;
    }

    this.deliverEvents(events);
  }

  // =========================================================================
  // Event delivery
  // =========================================================================

  private deliverEvents(events: PendingEvent[]): void {
    if (events.length === 0 || !this.ctx) return;

    const policyNames = [...new Set(events.map(e => e.policyName))];
    const lines = events
      .map(e => `- [${e.policyName}] (${e.eventType}): ${e.content}`)
      .join('\n');

    const text = `[Wake: ${events.length} event${events.length > 1 ? 's' : ''} matched]\n\n${lines}`;

    this.ctx.addMessage('user', [{ type: 'text', text }]);
    this.ctx.pushEvent({
      type: 'inference-request',
      agentName: this.agentName,
      reason: 'wake:events',
      source: 'wake',
    });

    if (this.onWake) {
      this.onWake(policyNames, `${events.length} event${events.length > 1 ? 's' : ''} delivered`);
    }
  }

  private flushInferenceBuffer(): void {
    if (this.inferenceBuffer.length === 0) return;
    const events = this.inferenceBuffer.splice(0);
    this.deliverEvents(events);
  }

  // =========================================================================
  // onProcess — handle non-MCPL external events
  // =========================================================================

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const source = (event as { source?: string }).source;
    if (source === 'cli' || source === 'tui' || source === 'wake:events' || source === 'wake:triggered') return {};

    this.reloadIfChanged();

    const content = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
    const eventType = source ?? 'external-message';

    const policy = this.matchPolicy(content, eventType, '', '');

    if (!policy) {
      // For non-MCPL events, we don't suppress — they're already in the queue.
      // The shouldTrigger callback only applies to MCPL ingress.
      return {};
    }

    if (this.onWake) {
      const snippet = content.length > MAX_WAKE_SNIPPET ? content.slice(0, MAX_WAKE_SNIPPET) + '...' : content;
      this.onWake([policy.name], snippet);
    }

    return {};
  }

  // =========================================================================
  // Tools — none. Agent edits wake.json directly with file tools.
  // =========================================================================

  getTools(): ToolDefinition[] {
    return [];
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: false, isError: true, error: 'WakeModule has no tools' };
  }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function validateWakeConfig(raw: unknown): WakeConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('wake.json must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  const defaultBehavior = obj.default ?? 'always';
  if (defaultBehavior !== 'always' && defaultBehavior !== 'suppress') {
    throw new Error(`wake.json "default" must be "always" or "suppress", got: ${defaultBehavior}`);
  }

  const policies: WakePolicy[] = [];
  const rawPolicies = obj.policies;
  if (Array.isArray(rawPolicies)) {
    for (const p of rawPolicies) {
      policies.push(validatePolicy(p));
    }
  }

  return { policies, default: defaultBehavior };
}

function validatePolicy(raw: unknown): WakePolicy {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Each wake policy must be an object');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error('Wake policy must have a "name" string');
  }

  // Validate behavior
  let behavior: WakePolicy['behavior'];
  if (obj.behavior === 'always' || obj.behavior === 'suppress') {
    behavior = obj.behavior;
  } else if (obj.behavior && typeof obj.behavior === 'object') {
    const b = obj.behavior as Record<string, unknown>;
    if (typeof b.debounce === 'number' && b.debounce > 0) {
      behavior = { debounce: b.debounce };
    } else {
      throw new Error(`Policy "${obj.name}": debounce must be a positive number`);
    }
  } else {
    behavior = 'always'; // default behavior
  }

  // Validate match (lenient — missing fields mean "match all")
  const match: WakePolicyMatch = {};
  if (obj.match && typeof obj.match === 'object') {
    const m = obj.match as Record<string, unknown>;
    if (Array.isArray(m.scope)) match.scope = m.scope.filter(s => typeof s === 'string');
    if (typeof m.source === 'string') match.source = m.source;
    if (typeof m.channel === 'string') match.channel = m.channel;
    if (m.filter && typeof m.filter === 'object') {
      const f = m.filter as Record<string, unknown>;
      if ((f.type === 'text' || f.type === 'regex') && typeof f.pattern === 'string') {
        match.filter = { type: f.type, pattern: f.pattern };
        // Validate regex
        if (f.type === 'regex') {
          try { new RegExp(f.pattern as string); } catch (e) {
            throw new Error(`Policy "${obj.name}": invalid regex pattern: ${e}`);
          }
        }
      }
    }
  }

  return { name: obj.name, match, behavior };
}

// ---------------------------------------------------------------------------
// Seed helper — writes wake.json if it doesn't exist
// ---------------------------------------------------------------------------

export function seedWakeConfig(configPath: string, config: WakeConfig): void {
  if (existsSync(configPath)) return; // Agent's edits take precedence
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}
