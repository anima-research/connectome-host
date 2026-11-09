import { For, Show } from 'solid-js';
import {
  PAGE_WAYS, goBackLines, openWays, restartLines, shownBanner, statusLines, type UpdateStatus, type UpdateWay,
} from '@conhost/web/update-text';

const BUTTON = 'px-1.5 py-0.5 rounded border border-current/40 hover:bg-white/10 font-mono text-[10px]';

function WayButtons(props: { ways: UpdateWay[]; onWay(way: UpdateWay): void }) {
  return (
    <span class="flex items-center gap-1 shrink-0">
      <For each={props.ways}>{(way) => (
        <button type="button" class={BUTTON} onClick={() => props.onWay(way)}>
          {PAGE_WAYS[way]}{way === 'restart' || way === 'back' ? '…' : ''}
        </button>
      )}</For>
    </span>
  );
}

export function UpdateBanner(props: {
  status: UpdateStatus | null;
  dismissed: string | null;
  onDismiss(line: string): void;
  onWay?(way: UpdateWay): void;
}) {
  const banner = () => shownBanner(props.status, props.dismissed);
  return (
    <Show when={banner()}>
      {(b) => (
        <div class="border-b border-sky-900 bg-sky-950/50 px-4 py-1.5 text-xs text-sky-100 flex items-center gap-2">
          <span class="w-2 h-2 rounded-full shrink-0 bg-sky-400" />
          <span class="font-mono text-[10px] uppercase tracking-wider opacity-70 shrink-0">update</span>
          <span class="min-w-0">{b().line}</span>
          <Show when={props.onWay}>
            <WayButtons ways={b().ways} onWay={(way) => props.onWay!(way)} />
          </Show>
          <Show when={b().dismissable}>
            <button
              type="button"
              class="ml-auto shrink-0 px-1 opacity-60 hover:opacity-100"
              title="Dismiss (back when the update has something else to say)"
              onClick={() => props.onDismiss(b().line)}
            >
              ✕
            </button>
          </Show>
        </div>
      )}
    </Show>
  );
}

export function UpdateBlock(props: { status: UpdateStatus; onWay?(way: UpdateWay): void }) {
  const ways = () => (props.onWay ? openWays(props.status) : []);
  return (
    <section class="border border-neutral-800 rounded px-2.5 py-2 space-y-1.5">
      <div class="flex items-center gap-2">
        <span class="text-neutral-100">update</span>
        <Show when={ways().length > 0}>
          <span class="ml-auto"><WayButtons ways={ways()} onWay={(way) => props.onWay!(way)} /></span>
        </Show>
      </div>
      <div class="text-neutral-400 whitespace-pre-wrap break-words">
        <For each={statusLines(props.status, PAGE_WAYS)}>{(line) => <div>{line}</div>}</For>
      </div>
    </section>
  );
}

export function UpdateDialog(props: {
  kind: 'restart' | 'back';
  status: UpdateStatus;
  onWay(way: UpdateWay): void;
  onClose(): void;
}) {
  const lines = () => (props.kind === 'restart' ? restartLines(props.status) ?? [] : goBackLines(props.status, PAGE_WAYS));
  const ways = (): UpdateWay[] => (props.kind === 'restart'
    ? (openWays(props.status).includes('restart') ? ['restart'] : [])
    : (openWays(props.status).includes('back') ? ['keep', 'restore'] : []));
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => props.onClose()}>
      <div class="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl max-w-lg w-full mx-4 p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div class="text-sm font-semibold mb-2 text-sky-300">{props.kind === 'restart' ? 'Restart' : 'Go back'}</div>
        <div class="text-neutral-300 text-sm mb-3 leading-snug space-y-1 break-words">
          <For each={lines()}>{(line) => <p>{line}</p>}</For>
        </div>
        <div class="flex gap-2 justify-end">
          <button type="button" class="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm" onClick={() => props.onClose()}>Cancel</button>
          <For each={ways()}>{(way) => (
            <button
              type="button"
              class={`px-3 py-1.5 rounded text-sm font-semibold ${way === 'restore'
                ? 'bg-amber-900/50 hover:bg-amber-900/80 text-amber-100'
                : 'bg-sky-900/50 hover:bg-sky-900/80 text-sky-100'}`}
              onClick={() => props.onWay(way)}
            >
              {PAGE_WAYS[way]}
            </button>
          )}</For>
        </div>
      </div>
    </div>
  );
}
