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

export type SurfaceName = 'headless' | 'readline' | 'tui' | 'web-ui';

export interface SurfaceTag {
  surface: SurfaceName;
  connection?: string;
}

export const SURFACE_TAG_KEY = 'connectomeSurface';

export interface SurfaceQuestion {
  agentName: string;
  text: string;
  final: boolean;
  connections: string[];
}

export type SurfaceAnswerer = (question: SurfaceQuestion) => string | undefined;

const SURFACE_ORDER: readonly SurfaceName[] = ['headless', 'readline', 'tui', 'web-ui'];

export class SurfaceAnswers {
  private readonly answerers = new Map<SurfaceName, SurfaceAnswerer>();

  answerFor(surface: SurfaceName, answerer: SurfaceAnswerer): () => void {
    this.answerers.set(surface, answerer);
    return () => { if (this.answerers.get(surface) === answerer) this.answerers.delete(surface); };
  }

  answer(surface: SurfaceName, question: SurfaceQuestion): string | undefined {
    try {
      return this.answerers.get(surface)?.(question);
    } catch (error) {
      console.error(`[surfaces] ${surface}'s answer failed:`, error);
      return undefined;
    }
  }
}

export const surfaceAnswers = new SurfaceAnswers();

export function readlineAnswer(stdoutIsTty: boolean): SurfaceAnswerer {
  const place = stdoutIsTty ? 'the terminal this host runs in' : "this host's standard output";
  return () => place;
}

export function tuiAnswer(rootAgentName: string): SurfaceAnswerer {
  return ({ agentName }) => agentName === rootAgentName ? 'the TUI' : undefined;
}

export function surfaceTagOf(metadata: unknown): SurfaceTag | undefined {
  const tag = (metadata as Record<string, unknown> | null | undefined)?.[SURFACE_TAG_KEY] as Partial<SurfaceTag> | undefined;
  if (!tag || typeof tag !== 'object' || !SURFACE_ORDER.includes(tag.surface as SurfaceName)) return undefined;
  return { surface: tag.surface as SurfaceName, ...(typeof tag.connection === 'string' ? { connection: tag.connection } : {}) };
}

export class TuiModule implements Module {
  readonly name = 'tui';
  private ctx: ModuleContext | null = null;

  constructor(private readonly answers: SurfaceAnswers = surfaceAnswers) {}

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
    const tag = surfaceTagOf((event as { metadata?: unknown }).metadata);

    const response: EventResponse = {
      addMessages: [
        {
          participant: 'user',
          content: [{ type: 'text', text }],
          ...(tag ? { metadata: { [SURFACE_TAG_KEY]: tag } } : {}),
        },
      ],
    };

    if (triggerInference !== false) {
      response.requestInference = targetAgents ?? true;
    }

    return response;
  }

  /**
   * Names where a surface whose message opened the turn showed `text`, and
   * otherwise answers `{}`. Only the turn's own surfaces are asked.
   */
  async onSpeechRouted(agentName: string, text: string, context: SpeechRoutedContext): Promise<SpeechSent> {
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
