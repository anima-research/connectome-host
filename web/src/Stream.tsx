/**
 * Stream pane — shows live events for a single tree node. The same panel is
 * used regardless of node kind; only the *source* of events differs (handled
 * upstream by App.tsx, which routes server messages through `formatStreamEvent`
 * (src/web/stream-lines.ts)
 * when they match the node's StreamSource).
 *
 * The pane is intentionally single-instance: clicking another node retargets
 * the panel rather than opening a second one. This mirrors the TUI's "peek
 * a node" UX, where focus is the unit of attention.
 */

import { For, Show } from 'solid-js';
import type { StreamLine } from '@conhost/web/stream-lines';


export function StreamPanel(props: {
  /** Display label of the focused node. */
  label: string;
  /** Sub-label hint — e.g. "subagent" / "fleet child" / "agent in <child>". */
  scopeHint?: string;
  lines: StreamLine[];
  onClose(): void;
  onStop?: () => void;
  canStop: boolean;
}) {
  return (
    <div class="border-l border-neutral-800 w-96 shrink-0 bg-neutral-950 flex flex-col h-full">
      <div class="border-b border-neutral-800 px-3 py-2 flex items-center gap-2">
        <span class="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">stream</span>
        <span class="font-mono text-sm text-neutral-200 truncate">{props.label}</span>
        <Show when={props.scopeHint}>
          <span class="text-[10px] text-neutral-500 italic truncate">{props.scopeHint}</span>
        </Show>
        <div class="ml-auto flex gap-1">
          <Show when={props.canStop && props.onStop}>
            <button
              type="button"
              class="px-2 py-0.5 bg-rose-900/40 hover:bg-rose-900/60 text-rose-200 rounded text-xs font-mono"
              onClick={() => props.onStop?.()}
              title="Stop this node"
            >
              stop
            </button>
          </Show>
          <button
            type="button"
            class="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs"
            onClick={() => props.onClose()}
          >
            close
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] space-y-0.5">
        <Show when={props.lines.length > 0} fallback={
          <div class="text-neutral-600 italic">Waiting for events…</div>
        }>
          <For each={props.lines}>{(line) => (
            <div class={line.color ?? 'text-neutral-300'}>
              {line.text || ' '}
            </div>
          )}</For>
        </Show>
      </div>
    </div>
  );
}
