/**
 * A real AgentFramework for the host's tests of what each agent's window
 * holds (#291): every agent's context follows its own window, so these tests
 * read the window (getPresentedMessages, ordinalOf) and the requests the
 * provider receives, not only what is stored. Residents share one store and
 * slot; each answers from a script of its own, routed by its model, and a
 * turn can wait on a gate tool, so a test can write while that turn is alive.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { AgentConfig, Module, ToolCall, ToolResult, TraceEvent } from '@animalabs/agent-framework';
import type { StoredMessage } from '@animalabs/context-manager';
import { Membrane, NativeFormatter } from '@animalabs/membrane';
import type { ProviderAdapter, ProviderRequest, ProviderResponse, StreamCallbacks } from '@animalabs/membrane';

/** One answer from a script: plain text, or a call of `gate--wait` that waits on the named gate. */
export type Reply = { text: string } | { wait: string };

/** The model each agent runs on, so the provider can tell whose call it is. */
export const modelOf = (agent: string): string => `model-${agent}`;

/** Answers each agent's calls from that agent's script, in order, and with
 *  `<agent> reply <n>` once its script is spent; records every request. */
export class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'scripted';
  readonly usageCacheConvention = 'cache-excluded' as const;
  readonly requests: Array<{ agent: string; request: ProviderRequest }> = [];
  private readonly scripts = new Map<string, Reply[]>();
  private readonly counts = new Map<string, number>();

  script(agent: string, ...replies: Reply[]): void {
    this.scripts.set(agent, [...(this.scripts.get(agent) ?? []), ...replies]);
  }

  callsFor(agent: string): number {
    return this.counts.get(agent) ?? 0;
  }

  /** What the agent's requests carried, each as one string. */
  wireOf(agent: string): string[] {
    return this.requests.filter((r) => r.agent === agent).map((r) => JSON.stringify(r.request.messages));
  }

  supportsModel(): boolean { return true; }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error(`unexpected non-streaming call for ${request.model}`);
  }

  async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    const agent = request.model.replace(/^model-/, '');
    const n = (this.counts.get(agent) ?? 0) + 1;
    this.counts.set(agent, n);
    this.requests.push({ agent, request });
    const next = this.scripts.get(agent)?.shift() ?? { text: `${agent} reply ${n}` };
    const content = 'wait' in next
      ? [{ type: 'tool_use', id: `call-${agent}-${n}`, name: 'gate--wait', input: { gate: next.wait } }]
      : [{ type: 'text', text: next.text }];
    if ('text' in next) callbacks.onChunk(next.text);
    return {
      content,
      stopReason: 'wait' in next ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
      model: request.model,
      rawRequest: request,
      raw: {},
    } as unknown as ProviderResponse;
  }
}

/** `gate--wait`: a call waits until its gate is released. */
export class GateModule implements Module {
  readonly name = 'gate';
  readonly entered = new Set<string>();
  private readonly waiting = new Map<string, () => void>();
  private readonly released = new Set<string>();
  async start(): Promise<void> {}
  async stop(): Promise<void> { this.releaseAll(); }
  async onProcess(): Promise<Record<string, never>> { return {}; }
  getTools() {
    return [{
      name: 'wait',
      description: 'Wait on a gate.',
      inputSchema: { type: 'object' as const, properties: { gate: { type: 'string' } } },
    }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const gate = String((call.input as { gate?: unknown }).gate);
    this.entered.add(gate);
    if (!this.released.has(gate)) await new Promise<void>((resolve) => this.waiting.set(gate, resolve));
    return { success: true, data: `gate ${gate} passed` };
  }
  release(gate: string): void {
    this.released.add(gate);
    this.waiting.get(gate)?.();
    this.waiting.delete(gate);
  }
  releaseAll(): void {
    for (const gate of [...this.waiting.keys()]) this.release(gate);
  }
}

/** Waits until `condition` holds, polling; fails naming `what` after `ms`. */
export async function until(condition: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const textOf = (row: { content: unknown }): string =>
  (Array.isArray(row.content) ? row.content : [])
    .map((b) => {
      const block = b as { type?: string; text?: string };
      return block.type === 'text' ? block.text ?? '' : '';
    })
    .join('');

export interface PresentedHost {
  framework: AgentFramework;
  adapter: ScriptedAdapter;
  gates: GateModule;
  traces: TraceEvent[];
  /** The agent's stored row whose text starts with `prefix`, the newest such. */
  rowWith(agent: string, prefix: string): StoredMessage | undefined;
  /** Whether the row is in the agent's window. */
  inWindow(agent: string, id: string): boolean;
  /** Nudge the agent and wait for the turn to end. */
  turn(agent: string): Promise<void>;
  /** Wait for every turn to end. */
  settled(agent: string): Promise<void>;
  cleanup(): Promise<void>;
}

/** Boot a framework with `agents` as residents on one store, `modules`
 *  beside the gate, and start it. */
export async function bootPresentedHost(opts: {
  agents: string[];
  modules?: Module[];
  agentConfig?: (name: string) => Partial<AgentConfig>;
  prefix?: string;
}): Promise<PresentedHost> {
  const dir = mkdtempSync(join(tmpdir(), opts.prefix ?? 'presented-host-'));
  const adapter = new ScriptedAdapter();
  const gates = new GateModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new Membrane(adapter, { formatter: new NativeFormatter() }),
    agents: opts.agents.map((name) => ({
      name,
      model: modelOf(name),
      systemPrompt: `You are ${name}.`,
      maxTokens: 256,
      allowedTools: 'all' as const,
      proseRouting: 'disabled' as const,
      ...opts.agentConfig?.(name),
    })),
    modules: [gates, ...(opts.modules ?? [])],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  } as never);
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => { traces.push(event); });
  framework.start();
  const turnAlive = (agent: string): boolean =>
    framework.getAgent(agent)?.state.status !== 'idle'
    || ((framework as unknown as { activeTurnTokens?: Map<string, unknown> }).activeTurnTokens?.has(agent) ?? false);
  const settled = (agent: string) => until(() => !turnAlive(agent), `${agent}'s turn to end`);
  return {
    framework,
    adapter,
    gates,
    traces,
    rowWith: (agent, prefix) => framework.getAgent(agent)!.getContextManager().getAllMessages()
      .filter((m) => textOf(m).startsWith(prefix)).at(-1),
    inWindow: (agent, id) => framework.getAgent(agent)!.getContextManager().ordinalOf(id) !== undefined,
    turn: async (agent) => {
      const before = adapter.callsFor(agent);
      const nudged = framework.nudgeAgent(agent, 'test');
      if (!nudged.ok) throw new Error(nudged.error);
      await until(() => adapter.callsFor(agent) > before, `${agent}'s request`);
      await settled(agent);
    },
    settled,
    cleanup: async () => {
      gates.releaseAll();
      await framework.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Store a row straight into a context and present it in that agent's window,
 * as a test's stand-in for what the framework stores while the agent has no
 * turn alive. Every agent's context follows its own window (agent-framework
 * #291): a row stored past the framework is in the record at once, and in
 * the window, so in a compile, a fork's inheritance and a peek, only once
 * presented.
 */
export function presentedRow(
  cm: { addMessage(participant: string, content: never): string; presentRows(ids: readonly string[]): void },
  participant: string,
  content: unknown,
): string {
  const id = cm.addMessage(participant, content as never);
  cm.presentRows([id]);
  return id;
}
