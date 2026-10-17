/**
 * The lines of the Web UI's stream panel: what each event of an agent's
 * stream shows as, and how many lines a panel keeps. The page imports it as
 * `@conhost/web/stream-lines`, which the server's tests can reach.
 */

import { traceError } from '../state/turn-trace.js';

export interface StreamLine {
  id: number;
  /** 'token' lines fold consecutive token events into one merged line for
   *  readable streaming output. Other event types render verbatim. */
  kind: 'token' | 'event';
  text: string;
  color?: string;
}

/** How many lines a stream panel holds: its newest, and once it has let
 *  older lines go, a first line among them saying how many. A subagent's or a fleet child's panel
 *  on a long run would otherwise grow without end. It counts lines, not their
 *  length: one line its stream never ends still grows with it. */
export const STREAM_LINES_KEPT = 2_000;

/** The first line of a panel that has let its oldest lines go. */
const DROPPED = /^… (\d+) earlier lines not shown$/;

/** A panel's lines with `added` after them, keeping the newest. Once a panel
 *  holds more than STREAM_LINES_KEPT, its first line says how many earlier
 *  lines it no longer shows, and the rest are the newest. */
export function withStreamLines(prev: readonly StreamLine[], added: readonly StreamLine[]): StreamLine[] {
  const first = prev[0];
  const marked = first?.kind === 'event' ? DROPPED.exec(first.text) : null;
  const dropped = marked ? Number(marked[1]) : 0;
  const lines = [...(marked ? prev.slice(1) : prev), ...added];
  if (dropped === 0 && lines.length <= STREAM_LINES_KEPT) return lines;
  // The line that says so takes one of the panel's places, so the first
  // overflow lets two lines go.
  const room = STREAM_LINES_KEPT - 1;
  const cut = Math.max(0, lines.length - room);
  const total = dropped + cut;
  return [
    { id: nextStreamLineId(), kind: 'event', text: `… ${total} earlier lines not shown`, color: 'text-neutral-500' },
    ...lines.slice(cut),
  ];
}

/** Convert a peek/child-event/trace into a renderable line. Returns null
 *  to mean "skip" (e.g. token events that the caller folds elsewhere). */
export function formatStreamEvent(event: { type: string; [k: string]: unknown }): StreamLine | null {
  const get = <T,>(k: string): T | undefined => event[k] as T | undefined;
  const id = nextStreamLineId();
  switch (event.type) {
    case 'inference:started':
    case 'tokens':
    case 'inference:tokens':
      return null;
    case 'inference:content_block':
    case 'inference:usage':
    case 'usage:updated':
      // Bookkeeping that a host agent's own traces carry (the trace-agent
      // panel's): a dot line per block or round is noise, as the TUI's fleet
      // view treats it too.
      return null;
    case 'tool_calls': {
      const calls = get<Array<{ name: string }>>('calls') ?? [];
      return { id, kind: 'event', text: `→ ${calls.map(c => c.name).join(', ')}`, color: 'text-amber-400' };
    }
    case 'inference:tool_calls_yielded': {
      const calls = get<Array<{ name: string }>>('calls') ?? [];
      return { id, kind: 'event', text: `→ ${calls.map(c => c.name).join(', ')}`, color: 'text-amber-400' };
    }
    case 'tool:started':
      return { id, kind: 'event', text: `  ⟳ ${get('tool') ?? get('name')}`, color: 'text-amber-300' };
    case 'tool:completed':
      return { id, kind: 'event', text: `  ✓ ${get('tool') ?? get('name')}`, color: 'text-cyan-400' };
    case 'tool:failed':
      return { id, kind: 'event', text: `  ✗ ${get('tool') ?? get('name')}: ${get('error') ?? ''}`, color: 'text-rose-400' };
    case 'inference:completed':
      return { id, kind: 'event', text: '── inference completed ──', color: 'text-neutral-500' };
    case 'inference:failed':
      return { id, kind: 'event', text: `✗ inference failed: ${traceError(event)}`, color: 'text-rose-400' };
    case 'inference:turn_ended':
      return { id, kind: 'event', text: '── turn ended by a tool ──', color: 'text-neutral-500' };
    case 'inference:aborted': {
      const reason = get<string>('reason');
      return { id, kind: 'event', text: `✗ turn aborted${reason ? `: ${reason}` : ''}`, color: 'text-amber-400' };
    }
    case 'inference:exhausted':
      return { id, kind: 'event', text: `✗ turn ended: ${traceError(event)}`, color: 'text-rose-400' };
    case 'lifecycle': {
      const phase = get<string>('phase');
      return { id, kind: 'event', text: `◆ lifecycle: ${phase}`, color: phase === 'ready' ? 'text-emerald-400' : 'text-neutral-500' };
    }
    case 'done': {
      const summary = get<string>('summary') ?? '(no summary)';
      return { id, kind: 'event', text: `✓ done: ${summary.slice(0, 100)}`, color: 'text-emerald-400' };
    }
    default:
      return { id, kind: 'event', text: `· ${event.type}`, color: 'text-neutral-600' };
  }
}

let streamIdCounter = 0;
function nextStreamLineId(): number { return ++streamIdCounter; }
