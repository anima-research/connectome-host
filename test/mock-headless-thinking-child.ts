import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';
import { TuiModule } from '../src/modules/tui-module.ts';

// Blocks stream as membrane's Anthropic adapter streams them with thinking
// on: each block's start, its deltas, then its finished payload.
type Block =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
const REPLY: Block[] = [
  { type: 'thinking', thinking: 'Weighing the question.', signature: 'test-signature' },
  { type: 'text', text: 'Hello.' },
  { type: 'thinking', thinking: 'One more thing to say.', signature: 'test-signature' },
  { type: 'text', text: 'World.' },
];
const TOOL_ROUND: Block[] = [
  { type: 'text', text: 'Checking.' },
  { type: 'tool_use', id: 'look-1', name: 'probe--look', input: {} },
];
const mode = process.env.CHILD_REPLY;

function roundOf(call: number): Block[] {
  if (mode === 'thinking-only') return [{ type: 'thinking', thinking: 'Nothing to say.', signature: 'test-signature' }];
  if (mode === 'then-skip' && call > 1) return [{ type: 'tool_use', id: `skip-${call}`, name: 'skip_reply', input: {} }];
  if (mode === 'tool-then-reply') return call === 1 ? TOOL_ROUND : [{ type: 'text', text: 'Done.' }];
  if (mode === 'tool-then-empty') return call === 1 ? TOOL_ROUND : [];
  if (mode === 'then-silent' && call === 2) return [{ type: 'text', text: 'Private self-check.' }];
  if (mode === 'then-silent-tool' && call === 2) return TOOL_ROUND;
  if (mode === 'then-silent-tool' && call === 3) return [{ type: 'text', text: 'Private self-check.' }];
  if (mode === 'then-silent' || mode === 'then-silent-tool') return call === 1 ? REPLY : [{ type: 'text', text: 'After.' }];
  return REPLY;
}

let calls = 0;
class ThinkingAdapter extends MockAdapter {
  override async stream(...[request, callbacks, options]: Parameters<MockAdapter['stream']>): ReturnType<MockAdapter['stream']> {
    options?.onRequest?.(request);
    calls += 1;
    const blocks = roundOf(calls);
    blocks.forEach((block, index) => {
      if (block.type === 'tool_use') {
        callbacks.onContentBlock?.(index, { ...block });
        callbacks.onContentBlock?.(index, block);
        return;
      }
      callbacks.onContentBlock?.(index, block.type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' });
      options?.onProgress?.();
      const words = block.type === 'text' ? block.text : block.thinking;
      const half = Math.ceil(words.length / 2);
      callbacks.onChunk(words.slice(0, half));
      options?.onProgress?.();
      callbacks.onChunk(words.slice(half));
      callbacks.onContentBlock?.(index, block);
    });
    return {
      content: [...blocks],
      stopReason: blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: request.model,
      rawRequest: request,
      raw: {},
    } as Awaited<ReturnType<MockAdapter['stream']>>;
  }
}

class ProbeModule implements Module {
  readonly name = 'probe';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'look', description: 'Look.', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: true, data: 'seen' };
  }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }
}

const dataDir = process.env.DATA_DIR!;
const framework = await AgentFramework.create({
  storePath: join(dataDir, 'store'),
  membrane: new Membrane(new ThinkingAdapter(), { formatter: new NativeFormatter() }),
  agents: [{ name: 'resident', model: 'mock', systemPrompt: 'test', maxTokens: 64 }],
  modules: [new TuiModule(), new ProbeModule()],
});
framework.start();
// skip_reply is a tool of the channel registry, which initializeMcpl starts.
if (process.env.CHILD_REPLY === 'then-skip') {
  await (framework as unknown as { initializeMcpl(servers: []): Promise<void> }).initializeMcpl([]);
}
if (mode === 'then-silent' || mode === 'then-silent-tool') {
  let fired = false;
  framework.onTrace((event) => {
    if (fired || (event as { type?: string }).type !== 'inference:completed') return;
    fired = true;
    setTimeout(() => (framework as unknown as { handleMcplPushEvent(event: unknown): void }).handleMcplPushEvent({
      type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat',
      eventId: 'hb-1', content: [], timestamp: new Date().toISOString(),
      origin: { source: 'heartbeat', reason: 'schedule', silent: true },
      inferenceId: 'inf-hb-1', triggerInference: true,
    }), 0);
  });
}
await runHeadless({
  recipe: { name: 'Thinking test', agent: { name: 'resident' } },
  agentName: 'resident',
  framework,
} as unknown as AppContext);
