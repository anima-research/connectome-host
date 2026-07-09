/**
 * TuiModule — handles external-message events from the TUI/CLI.
 *
 * Converts them to context messages and triggers inference.
 * Follows the same pattern as ApiModule's handleMessage().
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
} from '@animalabs/agent-framework';

export class TuiModule implements Module {
  readonly name = 'tui';

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: false, error: 'TuiModule has no tools', isError: true };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};

    const source = (event as { source: string }).source;
    if (source !== 'tui' && source !== 'cli' && source !== 'system' && source !== 'headless') return {};

    const content = (event as { content: unknown }).content;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const triggerInference = (event as { triggerInference?: boolean }).triggerInference;
    const targetAgents = (event as { targetAgents?: string[] }).targetAgents;

    // IPC/headless wakes carry no channel locus: the wake clears any
    // active-channel routing, so a plain-prose reply is NOT delivered to the
    // sender — it either falls back to the agent's home/default publish
    // channel (possibly the wrong audience) or strands in the chronicle
    // (routeSpeech: "no locus"). Agents can't see that from the message
    // itself, so tell them explicitly; otherwise they write replies into the
    // void (labclaude's stranded "Ack, ops" reply, 2026-07-09).
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
