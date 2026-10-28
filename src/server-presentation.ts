/**
 * agent-framework's server presentations (McplServerConfig.presentation,
 * 0.29.0): how agents are shown an MCPL server at first. `'full'` puts its
 * tools in the tool list; `'tab'` keeps it connected with none of its tools
 * listed until an agent opens its tab; `'closed-tab'` leaves it disconnected
 * until an agent opens it. Kept here, rather than imported, so the host
 * still builds against an agent-framework that predates them (which ignores
 * the key).
 */
export type ServerPresentation = 'full' | 'tab' | 'closed-tab';

export const SERVER_PRESENTATIONS: readonly ServerPresentation[] = ['full', 'tab', 'closed-tab'];

export const isServerPresentation = (value: unknown): value is ServerPresentation =>
  typeof value === 'string' && (SERVER_PRESENTATIONS as readonly string[]).includes(value);

/** `"full", "tab" or "closed-tab"`, for a refusal naming the values. */
export const SERVER_PRESENTATIONS_TEXT = SERVER_PRESENTATIONS.map((p) => JSON.stringify(p)).join(', ')
  .replace(/, ([^,]*)$/, ' or $1');
