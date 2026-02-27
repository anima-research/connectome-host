/**
 * SubagentModule — spawn and fork ephemeral subagents.
 *
 * Tools:
 *   subagent:spawn  — Fresh agent with system prompt + task, no inherited context
 *   subagent:fork   — Agent inheriting parent's compiled context
 *   subagent:launch — Non-blocking spawn/fork, returns task ID
 *   subagent:wait   — Block until launched tasks complete
 *
 * Interaction model (parallel-async-await):
 *   The LLM can emit multiple spawn/fork calls in one turn.
 *   The AF dispatches them concurrently. Parent blocks until all complete.
 *   Each subagent's findings are returned as the tool result.
 */

import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@connectome/agent-framework';
import type { AgentFramework } from '@connectome/agent-framework';
import { PassthroughStrategy } from '@connectome/agent-framework';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentModuleConfig {
  /** Maximum fork/spawn depth (default: 3) */
  maxDepth?: number;
  /** Current depth (incremented for child subagent modules) */
  currentDepth?: number;
  /** Default model for subagents */
  defaultModel?: string;
  /** Default max tokens per subagent inference */
  defaultMaxTokens?: number;
  /** Which parent agent this module serves (for fork context access) */
  parentAgentName?: string;
}

export interface SubagentResult {
  summary: string;
  findings: string[];
  issues: string[];
  toolCallsCount: number;
}

interface SpawnInput {
  name: string;
  systemPrompt: string;
  task: string;
  model?: string;
  maxTokens?: number;
  tools?: string[];
}

interface ForkInput {
  name: string;
  task: string;
  systemPrompt?: string;
  model?: string;
}

interface LaunchInput {
  name: string;
  systemPrompt?: string;
  task: string;
  fork?: boolean;
  model?: string;
}

interface WaitInput {
  taskId?: string;
  all?: boolean;
}

interface LaunchedTask {
  taskId: string;
  promise: Promise<SubagentResult>;
  resolve?: (result: SubagentResult) => void;
  result?: SubagentResult;
  completed: boolean;
}

/** Observable state of an active subagent, for TUI display. */
export interface ActiveSubagent {
  name: string;
  type: 'spawn' | 'fork';
  task: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  statusMessage?: string;
  toolCallsCount: number;
  findingsCount: number;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class SubagentModule implements Module {
  readonly name = 'subagent';

  private ctx: ModuleContext | null = null;
  private config: SubagentModuleConfig;
  private framework: AgentFramework | null = null;
  private maxDepth: number;
  private currentDepth: number;
  private launchedTasks = new Map<string, LaunchedTask>();
  private taskCounter = 0;

  /** Observable registry of active/recent subagents for TUI display. */
  readonly activeSubagents = new Map<string, ActiveSubagent>();

  constructor(config: SubagentModuleConfig = {}) {
    this.config = config;
    this.maxDepth = config.maxDepth ?? 3;
    this.currentDepth = config.currentDepth ?? 0;
  }

  /** Set the framework reference. Must be called after framework creation. */
  setFramework(framework: AgentFramework): void {
    this.framework = framework;
  }

  private getFramework(): AgentFramework {
    if (!this.framework) throw new Error('SubagentModule: framework not set. Call setFramework() after creating the framework.');
    return this.framework;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'spawn',
        description: 'Spawn a fresh subagent with a system prompt and task. Blocks until the subagent completes. Call multiple spawns in one turn to run them in parallel.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name for the subagent' },
            systemPrompt: { type: 'string', description: 'System prompt for the subagent' },
            task: { type: 'string', description: 'The task for the subagent to perform' },
            model: { type: 'string', description: 'Model override (optional)' },
            maxTokens: { type: 'number', description: 'Max tokens per inference (optional)' },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names the subagent can use (default: all non-subagent tools)',
            },
          },
          required: ['name', 'systemPrompt', 'task'],
        },
      },
      {
        name: 'fork',
        description: 'Fork a subagent that inherits your current context. The forked agent sees your full conversation history and can continue from where you are. Blocks until completion.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name for the forked agent' },
            task: { type: 'string', description: 'Additional task for the fork to perform' },
            systemPrompt: { type: 'string', description: 'Override system prompt (optional, defaults to parent)' },
            model: { type: 'string', description: 'Model override (optional)' },
          },
          required: ['name', 'task'],
        },
      },
      {
        name: 'launch',
        description: 'Non-blocking spawn or fork. Returns a task ID immediately. Use subagent:wait to collect results later.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name for the subagent' },
            systemPrompt: { type: 'string', description: 'System prompt (required for non-fork)' },
            task: { type: 'string', description: 'The task' },
            fork: { type: 'boolean', description: 'If true, fork parent context (default: false)' },
            model: { type: 'string', description: 'Model override (optional)' },
          },
          required: ['name', 'task'],
        },
      },
      {
        name: 'wait',
        description: 'Wait for launched subagent tasks to complete. Blocks until done.',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Specific task ID to wait for' },
            all: { type: 'boolean', description: 'Wait for all launched tasks (default: true)' },
          },
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    switch (call.name) {
      case 'spawn':
        return this.handleSpawn(call.input as SpawnInput);
      case 'fork':
        return this.handleFork(call.input as ForkInput);
      case 'launch':
        return this.handleLaunch(call.input as LaunchInput);
      case 'wait':
        return this.handleWait(call.input as WaitInput);
      default:
        return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // =========================================================================
  // Tool Handlers
  // =========================================================================

  private async handleSpawn(input: SpawnInput): Promise<ToolResult> {
    if (this.currentDepth >= this.maxDepth) {
      return {
        success: false,
        isError: true,
        error: `Max subagent depth ${this.maxDepth} reached`,
      };
    }

    try {
      const result = await this.runSpawn(input);
      return { success: true, data: result };
    } catch (err) {
      return {
        success: false,
        isError: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async handleFork(input: ForkInput): Promise<ToolResult> {
    if (this.currentDepth >= this.maxDepth) {
      return {
        success: false,
        isError: true,
        error: `Max subagent depth ${this.maxDepth} reached`,
      };
    }

    try {
      const result = await this.runFork(input);
      return { success: true, data: result };
    } catch (err) {
      return {
        success: false,
        isError: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async handleLaunch(input: LaunchInput): Promise<ToolResult> {
    if (this.currentDepth >= this.maxDepth) {
      return {
        success: false,
        isError: true,
        error: `Max subagent depth ${this.maxDepth} reached`,
      };
    }

    const taskId = `task-${++this.taskCounter}`;

    const promise = input.fork
      ? this.runFork({
          name: input.name,
          task: input.task,
          systemPrompt: input.systemPrompt,
          model: input.model,
        })
      : this.runSpawn({
          name: input.name,
          systemPrompt: input.systemPrompt ?? 'You are a helpful research assistant.',
          task: input.task,
          model: input.model,
        });

    const task: LaunchedTask = {
      taskId,
      promise,
      completed: false,
    };

    // When promise resolves, mark completed
    promise.then(result => {
      task.result = result;
      task.completed = true;
    }).catch(err => {
      task.result = {
        summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
        findings: [],
        issues: [String(err)],
        toolCallsCount: 0,
      };
      task.completed = true;
    });

    this.launchedTasks.set(taskId, task);

    return { success: true, data: { taskId } };
  }

  private async handleWait(input: WaitInput): Promise<ToolResult> {
    if (input.taskId) {
      const task = this.launchedTasks.get(input.taskId);
      if (!task) {
        return { success: false, isError: true, error: `Unknown task: ${input.taskId}` };
      }
      const result = await task.promise;
      this.launchedTasks.delete(input.taskId);
      return { success: true, data: result };
    }

    // Wait for all
    const results: Record<string, SubagentResult> = {};
    for (const [id, task] of this.launchedTasks) {
      results[id] = await task.promise;
    }
    this.launchedTasks.clear();
    return { success: true, data: results };
  }

  // =========================================================================
  // Subagent Execution
  // =========================================================================

  private async runSpawn(input: SpawnInput): Promise<SubagentResult> {
    const agentName = `spawn-${input.name}-${Date.now()}`;
    const entry: ActiveSubagent = {
      name: input.name, type: 'spawn', task: input.task,
      status: 'running', startedAt: Date.now(), toolCallsCount: 0, findingsCount: 0,
    };
    this.activeSubagents.set(agentName, entry);

    const framework = this.getFramework();
    const { agent, contextManager, cleanup } = await framework.createEphemeralAgent({
      name: agentName,
      model: input.model ?? this.config.defaultModel ?? 'claude-haiku-4-5-20251001',
      systemPrompt: input.systemPrompt,
      maxTokens: input.maxTokens ?? this.config.defaultMaxTokens ?? 4096,
      strategy: new PassthroughStrategy(),
      allowedTools: this.filterToolNames(input.tools),
    });

    try {
      contextManager.addMessage('user', [{ type: 'text', text: input.task }]);

      // Run through the framework's event loop — full traces, logging, tool dispatch
      const { speech, toolCallsCount } = await framework.runEphemeralToCompletion(agent, contextManager);

      entry.status = 'completed';
      entry.toolCallsCount = toolCallsCount;
      return { summary: speech, findings: [], issues: [], toolCallsCount };
    } catch (err) {
      entry.status = 'failed';
      entry.statusMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      cleanup();
    }
  }

  private async runFork(input: ForkInput): Promise<SubagentResult> {
    const agentName = input.name;
    const entry: ActiveSubagent = {
      name: input.name, type: 'fork', task: input.task,
      status: 'running', startedAt: Date.now(), toolCallsCount: 0, findingsCount: 0,
    };
    this.activeSubagents.set(agentName, entry);

    const framework = this.getFramework();

    const parentAgent = this.config.parentAgentName
      ? framework.getAgent(this.config.parentAgentName)
      : null;

    const systemPrompt = input.systemPrompt
      ?? (parentAgent ? parentAgent.systemPrompt : 'You are a research assistant.');

    const { agent, contextManager, cleanup } = await framework.createEphemeralAgent({
      name: agentName,
      model: input.model ?? this.config.defaultModel ?? 'claude-haiku-4-5-20251001',
      systemPrompt,
      maxTokens: this.config.defaultMaxTokens ?? 4096,
      strategy: new PassthroughStrategy(),
      allowedTools: this.filterToolNames(),
    });

    try {
      // Copy parent's compiled (already-compressed) context into the fork.
      // This gives the fork diary summaries + recent messages instead of the
      // full raw history, preventing context overflow on long-running parents.
      if (parentAgent) {
        const parentCM = parentAgent.getContextManager();
        const { messages: compiled } = await parentCM.compile();
        for (const msg of compiled) {
          const participant = msg.participant === parentAgent.name ? agentName : msg.participant;
          contextManager.addMessage(participant, msg.content);
        }
      }

      contextManager.addMessage('user', [{ type: 'text', text: input.task }]);

      const { speech, toolCallsCount } = await framework.runEphemeralToCompletion(agent, contextManager);

      entry.status = 'completed';
      entry.toolCallsCount = toolCallsCount;
      return { summary: speech, findings: [], issues: [], toolCallsCount };
    } catch (err) {
      entry.status = 'failed';
      entry.statusMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      cleanup();
    }
  }

  /**
   * Build the allowedTools list for a subagent.
   * Removes subagent tools if at depth limit.
   */
  private filterToolNames(allowedTools?: string[]): 'all' | string[] {
    if (this.currentDepth + 1 >= this.maxDepth) {
      const allTools = this.getFramework().getAllTools();
      const filtered = allTools
        .filter(t => !t.name.startsWith('subagent:'))
        .map(t => t.name);
      if (allowedTools) {
        const allowed = new Set(allowedTools);
        return filtered.filter(n => allowed.has(n));
      }
      return filtered;
    }
    return allowedTools ?? 'all';
  }

}
