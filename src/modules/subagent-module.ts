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
import type { AgentFramework, Agent } from '@connectome/agent-framework';
import type { ContextManager } from '@connectome/context-manager';
import type { ContentBlock } from 'membrane';
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
    const { agent, contextManager, cleanup } = await this.getFramework().createEphemeralAgent({
      name: agentName,
      model: input.model ?? this.config.defaultModel ?? 'claude-haiku-4-5-20251001',
      systemPrompt: input.systemPrompt,
      maxTokens: input.maxTokens ?? this.config.defaultMaxTokens ?? 4096,
      strategy: new PassthroughStrategy(),
    });

    try {
      // Inject the task as a user message
      contextManager.addMessage('user', [{ type: 'text', text: input.task }]);

      // Get available tools (filter out subagent tools to prevent recursive spawning
      // beyond depth limit — child gets its own SubagentModule at depth+1)
      const allTools = this.getFramework().getAllTools();
      const tools = this.filterToolsForSubagent(allTools, input.tools);

      return await this.driveToCompletion(agent, tools);
    } finally {
      cleanup();
    }
  }

  private async runFork(input: ForkInput): Promise<SubagentResult> {
    const agentName = `fork-${input.name}-${Date.now()}`;

    // Get parent agent's compiled context
    const parentAgent = this.config.parentAgentName
      ? this.getFramework().getAgent(this.config.parentAgentName)
      : null;

    // Determine system prompt
    const systemPrompt = input.systemPrompt
      ?? (parentAgent ? parentAgent.systemPrompt : 'You are a research assistant.');

    const { agent, contextManager, cleanup } = await this.getFramework().createEphemeralAgent({
      name: agentName,
      model: input.model ?? this.config.defaultModel ?? 'claude-haiku-4-5-20251001',
      systemPrompt,
      maxTokens: this.config.defaultMaxTokens ?? 4096,
      strategy: new PassthroughStrategy(),
    });

    try {
      // Copy parent's messages into the fork's context
      if (parentAgent) {
        const parentCM = parentAgent.getContextManager();
        const { messages } = parentCM.queryMessages({});
        for (const msg of messages) {
          contextManager.addMessage(msg.participant, msg.content, msg.metadata);
        }
      }

      // Inject the fork task
      contextManager.addMessage('user', [{ type: 'text', text: input.task }]);

      const allTools = this.getFramework().getAllTools();
      const tools = this.filterToolsForSubagent(allTools);

      return await this.driveToCompletion(agent, tools);
    } finally {
      cleanup();
    }
  }

  /**
   * Drive a subagent through its inference loop until it has no more tool calls.
   *
   * Works directly with the membrane's YieldingStream. Each inference round:
   *   1. Start stream (compiles context, sends to LLM)
   *   2. Iterate events: collect tokens, handle tool calls, detect completion
   *   3. On tool-calls: execute tools, convert to membrane format, resume stream
   *   4. On complete: save assistant response, check if more rounds needed
   */
  private async driveToCompletion(
    agent: Agent,
    tools: ToolDefinition[],
  ): Promise<SubagentResult> {
    const findings: string[] = [];
    const issues: string[] = [];
    let speech = '';
    let toolCallsCount = 0;

    const MAX_ROUNDS = 20; // Safety limit
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const { stream } = await agent.startStreamWithInjections(tools);
      let hadToolCalls = false;

      for await (const event of stream) {
        switch (event.type) {
          case 'tokens':
            speech += event.content;
            break;

          case 'tool-calls': {
            hadToolCalls = true;
            const calls = event.calls;
            toolCallsCount += calls.length;

            // Execute each tool call
            const afResults = await Promise.all(
              calls.map(async (call: ToolCall) =>
                this.executeSubagentToolCall(call, findings, issues)
              )
            );

            // Store assistant message (tool_use blocks)
            const assistantBlocks: ContentBlock[] = [];
            if (event.context.preamble) {
              assistantBlocks.push({ type: 'text', text: event.context.preamble });
            }
            for (const c of calls) {
              assistantBlocks.push({
                type: 'tool_use',
                id: c.id,
                name: c.name,
                input: c.input as Record<string, unknown>,
              });
            }
            agent.addAssistantResponse(assistantBlocks);

            // Store tool result message
            const toolResultContent: ContentBlock[] = calls.map((c: ToolCall, i: number) => ({
              type: 'tool_result' as const,
              toolUseId: c.id,
              content: afResults[i]!.isError
                ? (afResults[i]!.error ?? 'Unknown error')
                : JSON.stringify(afResults[i]!.data),
              isError: afResults[i]!.isError,
            }));
            agent.getContextManager().addMessage('user', toolResultContent);

            // Convert to membrane format and resume stream
            const membraneResults = calls.map((c: ToolCall, i: number) => ({
              toolUseId: c.id,
              content: afResults[i]!.isError
                ? (afResults[i]!.error ?? 'Unknown error')
                : JSON.stringify(afResults[i]!.data),
              isError: afResults[i]!.isError,
            }));
            stream.provideToolResults(membraneResults);
            break;
          }

          case 'complete': {
            // Store trailing assistant response
            const response = event.response;
            if (hadToolCalls) {
              const trailing = response.content.filter(
                (block: ContentBlock) => block.type !== 'tool_use' && block.type !== 'tool_result'
              );
              if (trailing.length > 0) {
                agent.addAssistantResponse(trailing);
              }
            } else {
              agent.addAssistantResponse(response.content);
            }
            break;
          }

          case 'error': {
            const errEvt = event as unknown as { error?: Error | string };
            const errMsg = errEvt.error instanceof Error ? errEvt.error.message
              : (errEvt.error ?? 'Unknown inference error');
            issues.push(errMsg);
            break;
          }
        }
      }

      // After the stream completes, reset agent to idle
      agent.reset();

      // If we had no tool calls, inference is truly done
      if (!hadToolCalls) break;
    }

    return { summary: speech, findings, issues, toolCallsCount };
  }

  /**
   * Execute a tool call for a subagent, intercepting report_* tools.
   */
  private async executeSubagentToolCall(
    call: ToolCall,
    findings: string[],
    issues: string[],
  ): Promise<ToolResult> {
    const localName = call.name.includes(':')
      ? call.name.split(':').slice(1).join(':')
      : call.name;

    // Intercept reporting tools
    if (localName === 'report_finding' || call.name === 'subagent:report_finding') {
      const content = (call.input as { content: string }).content;
      findings.push(content);
      return { success: true, data: { recorded: true } };
    }
    if (localName === 'report_progress' || call.name === 'subagent:report_progress') {
      // Push to parent queue for TUI display
      // Progress events are emitted for TUI display but don't require framework routing
      // For now, just log them — the TUI can observe via trace events
      // TODO: use a proper custom event type when the AF supports it
      return { success: true, data: { recorded: true } };
    }

    // Route to the framework's tool dispatch (handles both modules and MCPL)
    try {
      const result = await this.getFramework().executeToolCall(call);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`Tool ${call.name} failed: ${msg}`);
      return { success: false, error: msg, isError: true };
    }
  }

  /**
   * Filter available tools for a subagent.
   * Removes subagent tools (to prevent uncontrolled recursion) unless depth allows it.
   */
  private filterToolsForSubagent(
    allTools: ToolDefinition[],
    allowedTools?: string[],
  ): ToolDefinition[] {
    let tools = allTools;

    // Filter to allowed list if specified
    if (allowedTools) {
      const allowed = new Set(allowedTools);
      tools = tools.filter(t => allowed.has(t.name));
    }

    // Remove subagent spawn/fork tools if at depth limit - 1
    // (the child is at currentDepth + 1)
    if (this.currentDepth + 1 >= this.maxDepth) {
      tools = tools.filter(t => !t.name.startsWith('subagent:'));
    }

    return tools;
  }
}
