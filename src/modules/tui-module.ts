import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  SpeechRoutedContext,
  SpeechSent,
} from '@animalabs/agent-framework';
import { unknownToolResult } from './unknown-tool.js';
import { REPLY_UNHEARD_KEY, SURFACE_ORDER, SURFACE_TAG_KEY, SurfaceAnswers, surfaceTagOf, type SurfaceName } from '../surfaces.js';

const REPLY_UNHEARD_NOTE = '[host note: the client that sent this wasn\'t subscribed to inference:speech when it ' +
  'arrived, so a plain-prose reply won\'t reach it unless it subscribes.]';

export class TuiModule implements Module {
  readonly name = 'tui';
  private ctx: ModuleContext | null = null;

  constructor(private readonly answers: SurfaceAnswers) {}

  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
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
    const metadata = (event as { metadata?: Record<string, unknown> }).metadata;
    const tag = surfaceTagOf(metadata);
    const unheard = source === 'headless' && metadata?.[REPLY_UNHEARD_KEY] === true;

    const response: EventResponse = {
      addMessages: [
        {
          participant: 'user',
          content: [{ type: 'text', text }, ...(unheard ? [{ type: 'text' as const, text: REPLY_UNHEARD_NOTE }] : [])],
          ...(tag ? { metadata: { [SURFACE_TAG_KEY]: tag } } : {}),
        },
      ],
    };

    if (triggerInference !== false) {
      response.requestInference = targetAgents ?? true;
    }

    return response;
  }

  onSpeechRouted(agentName: string, text: string, context: SpeechRoutedContext): SpeechSent {
    const connections = new Map<SurfaceName, string[]>();
    for (const id of context.openedBy?.messages ?? []) {
      const tag = surfaceTagOf(this.ctx?.getMessage(id)?.metadata);
      if (!tag) continue;
      const known = connections.get(tag.surface) ?? [];
      if (tag.connection !== undefined && !known.includes(tag.connection)) known.push(tag.connection);
      connections.set(tag.surface, known);
    }
    const places = SURFACE_ORDER.filter((surface) => connections.has(surface))
      .map((surface) => this.answers.answer(surface, { agentName, text, final: context.final, connections: connections.get(surface)! }))
      .filter((place): place is string => !!place);
    return places.length > 0 ? { sentTo: places.join(' and ') } : {};
  }
}
