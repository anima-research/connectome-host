import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';
import { unknownToolResult } from './unknown-tool.js';

export class TuiModule implements Module {
  readonly name = 'tui';

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return unknownToolResult(this, call.name);
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};

    const source = (event as { source: string }).source;
    if (source !== 'tui' && source !== 'cli' && source !== 'system' && source !== 'headless') return {};

    const content = (event as { content: unknown }).content;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const triggerInference = (event as { triggerInference?: boolean }).triggerInference;
    const targetAgents = (event as { targetAgents?: string[] }).targetAgents;

    // agent-framework routes plain prose by channel, and an IPC wake carries
    // none: a turn it opens takes the agent's home or default publish channel as
    // its locus, or none, and a wake during an open turn keeps that turn's locus.
    const blocks: Array<{ type: 'text'; text: string }> = [{ type: 'text', text }];
    if (source === 'headless') {
      blocks.push({
        type: 'text',
        text:
          '[host note: this message arrived over IPC and carries no channel locus — ' +
          'any active-channel routing from your previous turn no longer applies. A plain-prose ' +
          'reply will NOT reach the sender: it may fall back to your home/default channel or stay ' +
          'in your chronicle only. To answer a specific person or channel, use an explicit send tool; ' +
          'if no reply is needed, none is expected.]',
      });
    }

    const response: EventResponse = {
      addMessages: [
        {
          participant: 'user',
          content: blocks,
        },
      ],
    };

    if (triggerInference !== false) {
      response.requestInference = targetAgents ?? true;
    }

    return response;
  }
}
