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
  ContentBlock,
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
    const triggerInference = (event as { triggerInference?: boolean }).triggerInference;
    const targetAgents = (event as { targetAgents?: string[] }).targetAgents;

    const blocks: ContentBlock[] = operatorBlocks(content)
      ?? [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content) }];

    // IPC/headless wakes carry no channel locus: the wake clears any
    // active-channel routing, so a plain-prose reply is NOT delivered to the
    // sender — it either falls back to the agent's home/default publish
    // channel (possibly the wrong audience) or strands in the chronicle
    // (routeSpeech: "no locus"). Agents can't see that from the message
    // itself, so tell them explicitly; otherwise they write replies into the
    // void (labclaude's stranded "Ack, ops" reply, 2026-07-09).
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

/**
 * Content that is already message blocks — text, and base64 images (the
 * WebUI's composer sends both) — goes into the message as it is. Anything
 * else returns null and is stored as text, as before.
 */
function operatorBlocks(content: unknown): ContentBlock[] | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  for (const raw of content) {
    const b = raw as { type?: unknown; text?: unknown; source?: { type?: unknown; data?: unknown; mediaType?: unknown } } | null;
    if (!b || typeof b !== 'object') return null;
    if (b.type === 'text' && typeof b.text === 'string') continue;
    if (
      b.type === 'image'
      && b.source?.type === 'base64'
      && typeof b.source.data === 'string'
      && typeof b.source.mediaType === 'string'
    ) continue;
    return null;
  }
  return [...content] as ContentBlock[];
}
