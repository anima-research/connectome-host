export type SurfaceName = 'headless' | 'readline' | 'tui' | 'web-ui';

/** The host's own name for the surface that sent a message, and for headless
 *  and the Web UI the connection. It splits the message's `source`, which
 *  agent-framework stores and its readers see: `source` is `'cli'` for readline
 *  and `connectome send` alike, `'tui'` for the TUI and a Web UI page alike, and
 *  `'headless'` for a socket text without `from`, but each surface answers only
 *  for what it showed. Which surfaces are asked where a routed piece was shown,
 *  and with which connection, comes from this tag alone, never from `source`. */
export interface SurfaceTag {
  surface: SurfaceName;
  connection?: string;
}

export const SURFACE_TAG_KEY = 'connectomeSurface';
export const REPLY_UNHEARD_KEY = 'connectomeReplyUnheard';

export interface SurfaceQuestion {
  agentName: string;
  text: string;
  final: boolean;
  connections: string[];
}

export type SurfaceAnswerer = (question: SurfaceQuestion) => string | undefined;

export const SURFACE_ORDER: readonly SurfaceName[] = ['headless', 'readline', 'tui', 'web-ui'];

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

export function readlineAnswer(stdoutIsTty: boolean): SurfaceAnswerer {
  const place = stdoutIsTty ? 'the terminal this host runs in' : "this host's standard output";
  return () => place;
}

export function tuiAnswer(rootAgentName: string, backgrounded: () => boolean): SurfaceAnswerer {
  return ({ agentName }) => {
    if (agentName !== rootAgentName) return undefined;
    return backgrounded() ? 'the TUI, which holds it while this turn runs in the background' : 'the TUI';
  };
}

export function surfaceTagOf(metadata: unknown): SurfaceTag | undefined {
  const tag = (metadata as Record<string, unknown> | null | undefined)?.[SURFACE_TAG_KEY] as Partial<SurfaceTag> | undefined;
  if (!tag || typeof tag !== 'object' || !SURFACE_ORDER.includes(tag.surface as SurfaceName)) return undefined;
  if (tag.connection !== undefined && typeof tag.connection !== 'string') return undefined;
  return { surface: tag.surface as SurfaceName, ...(typeof tag.connection === 'string' ? { connection: tag.connection } : {}) };
}
