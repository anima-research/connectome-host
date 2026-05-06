/**
 * Lessons panel — read-only view of the parent process's lesson library.
 *
 * Shows active lessons sorted by confidence; deprecated entries collapse to a
 * dim line with the reason. Manual refresh button — lessons mutate slowly
 * (knowledge-miner pipeline is the typical writer), so we don't auto-poll.
 */

import { For, Show } from 'solid-js';

export interface LessonRow {
  id: string;
  content: string;
  confidence: number;
  tags: string[];
  deprecated: boolean;
  deprecationReason?: string;
  created?: number;
  updated?: number;
}

export function LessonsPanel(props: {
  /** True once a lessons-list response has come back; false during initial
   *  request so the panel can show a "loading…" hint. */
  loaded: boolean;
  /** True if the LessonsModule is mounted in the recipe. */
  moduleLoaded: boolean;
  lessons: LessonRow[];
  /** Currently-selected scope ('local' for the parent process, or a fleet
   *  child name). Drives which process's lessons are shown. */
  scope: string;
  /** Selectable scopes — always includes 'local', plus every fleet child. */
  scopes: Array<{ id: string; label: string }>;
  onScopeChange(scope: string): void;
  onRefresh(): void;
}) {
  const active = (): LessonRow[] => props.lessons.filter(l => !l.deprecated)
    .sort((a, b) => b.confidence - a.confidence);
  const deprecated = (): LessonRow[] => props.lessons.filter(l => l.deprecated);

  return (
    <div class="h-full overflow-y-auto px-3 py-2 text-xs">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold">
          lessons
        </span>
        <Show when={props.moduleLoaded}>
          <span class="text-neutral-600 text-[10px]">
            {active().length} active
            <Show when={deprecated().length > 0}> · {deprecated().length} deprecated</Show>
          </span>
        </Show>
        <button
          type="button"
          class="ml-auto px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
          onClick={() => props.onRefresh()}
          title="Re-fetch the lesson library"
        >
          refresh
        </button>
      </div>
      <ScopePicker scope={props.scope} scopes={props.scopes} onChange={props.onScopeChange} />

      <Show when={!props.loaded} fallback={null}>
        <div class="text-neutral-600 italic">Loading…</div>
      </Show>

      <Show when={props.loaded && !props.moduleLoaded}>
        <div class="text-neutral-600 italic">
          LessonsModule not loaded in this recipe. Enable it under
          {' '}<span class="font-mono">modules.lessons</span> to populate this panel.
        </div>
      </Show>

      <Show when={props.loaded && props.moduleLoaded && active().length === 0 && deprecated().length === 0}>
        <div class="text-neutral-600 italic">
          No lessons yet. The agent creates them during analysis.
        </div>
      </Show>

      <div class="space-y-2">
        <For each={active()}>{(l) => <LessonCard lesson={l} />}</For>
      </div>

      <Show when={deprecated().length > 0}>
        <div class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold mt-4 mb-1">
          deprecated
        </div>
        <div class="space-y-1 opacity-60">
          <For each={deprecated()}>{(l) => <LessonCard lesson={l} />}</For>
        </div>
      </Show>
    </div>
  );
}

/** Compact scope chooser shown at the top of scoped panels. The current
 *  scope is rendered as a pill; alternative scopes appear as siblings.
 *  Hidden when there's only one scope (no fleet children). */
export function ScopePicker(props: {
  scope: string;
  scopes: Array<{ id: string; label: string }>;
  onChange(scope: string): void;
}) {
  return (
    <Show when={props.scopes.length > 1}>
      <div class="flex flex-wrap items-center gap-1 mb-2 text-[10px] font-mono">
        <span class="text-neutral-600 uppercase tracking-wider mr-1">scope</span>
        <For each={props.scopes}>{(s) => (
          <button
            type="button"
            class={`px-1.5 py-0.5 rounded ${
              props.scope === s.id
                ? 'bg-cyan-900/60 text-cyan-100'
                : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-300'
            }`}
            onClick={() => props.onChange(s.id)}
          >
            {s.label}
          </button>
        )}</For>
      </div>
    </Show>
  );
}

function LessonCard(props: { lesson: LessonRow }) {
  const conf = (): number => Math.round(props.lesson.confidence * 100);
  const confColor = (): string => {
    const c = conf();
    if (c >= 80) return 'bg-emerald-900/40 text-emerald-200';
    if (c >= 50) return 'bg-amber-900/40 text-amber-200';
    return 'bg-neutral-800 text-neutral-400';
  };
  return (
    <div class="border border-neutral-800 rounded px-2 py-1.5 bg-neutral-950">
      <div class="flex items-baseline gap-2 mb-0.5">
        <span class={`text-[10px] font-mono px-1 rounded ${confColor()}`}>
          {conf()}%
        </span>
        <span class="text-[10px] font-mono text-neutral-600 truncate" title={props.lesson.id}>
          {props.lesson.id}
        </span>
      </div>
      <div class="text-neutral-200 leading-snug whitespace-pre-wrap">
        {props.lesson.content}
      </div>
      <Show when={props.lesson.tags.length > 0}>
        <div class="mt-1 flex flex-wrap gap-1">
          <For each={props.lesson.tags}>{(tag) => (
            <span class="text-[10px] font-mono text-neutral-500 bg-neutral-900 px-1 rounded">
              {tag}
            </span>
          )}</For>
        </div>
      </Show>
      <Show when={props.lesson.deprecationReason}>
        <div class="mt-1 text-[10px] text-rose-300 italic">
          deprecated: {props.lesson.deprecationReason}
        </div>
      </Show>
    </div>
  );
}
