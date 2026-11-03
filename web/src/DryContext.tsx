import { For, Show } from 'solid-js';

interface Seg { messages: number; tokens: number }
interface DryStats {
  head: Seg; tail: Seg; middleRaw: Seg;
  summaries?: Record<string, { count: number; tokens: number }>;
  total: Seg;
}

export interface DryContextData {
  entries: unknown[];
  stats?: unknown;
  label: string;
}

const fmt = (n: number) => n.toLocaleString();

const CONTEXT_MANAGER_RECALL_MARKERS = ['what do you remember', 'recall memory', '[cm]'];
const isRecallPrompt = (s: string) =>
  s.length < 400 && CONTEXT_MANAGER_RECALL_MARKERS.some((m) => s.toLowerCase().includes(m));

export function DryContext(props: { data: DryContextData | null; onClose(): void }) {
  const rows = () =>
    (props.data?.entries ?? []).map((e, i) => {
      const o = (e ?? {}) as {
        i?: number; who?: string; text?: string; chars?: number;
        media?: number; truncated?: boolean;
      };
      const body = o.text ?? '';
      return {
        i: o.i ?? i,
        who: o.who ?? '?',
        body,
        recall: isRecallPrompt(body),
        chars: o.chars ?? body.length,
        media: o.media ?? 0,
        truncated: o.truncated === true,
      };
    });

  const stats = () => props.data?.stats as DryStats | undefined;

  return (
    <div class="h-full overflow-y-auto">
      <Show
        when={props.data}
        fallback={
          <div class="p-6 text-neutral-500 text-sm">
            No dry run yet. Open <span class="font-mono text-neutral-400">Settings</span> in the
            sidebar, set a budget, and press{' '}
            <span class="font-mono text-cyan-300">dry run + show context</span>.
          </div>
        }
      >
        <div class="sticky top-0 z-10 bg-amber-950/80 backdrop-blur border-b border-amber-800
                    px-4 py-2 text-[11px] text-amber-200 flex items-center gap-3 flex-wrap">
          <span class="font-semibold uppercase tracking-wider">dry run — not applied</span>
          <span class="font-mono text-amber-300/90">{props.data!.label}</span>
          <span class="text-amber-300/70">
            the agent is still running its current settings
          </span>
          <button
            type="button"
            class="ml-auto px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700
                   text-neutral-300 font-mono text-[10px]"
            onClick={() => props.onClose()}
          >
            close
          </button>
        </div>

        <Show when={stats()}>
          <div class="px-4 py-2 border-b border-neutral-800 text-[11px] font-mono
                      text-neutral-400 flex gap-4 flex-wrap">
            <span>entries <span class="text-neutral-200">{fmt(rows().length)}</span></span>
            <span>head <span class="text-neutral-200">{fmt(stats()!.head?.tokens ?? 0)}</span></span>
            <span>middle <span class="text-neutral-200">{fmt(stats()!.middleRaw?.tokens ?? 0)}</span></span>
            <span>tail <span class="text-neutral-200">{fmt(stats()!.tail?.tokens ?? 0)}</span></span>
            <span>total <span class="text-neutral-200">{fmt(stats()!.total?.tokens ?? 0)}</span></span>
          </div>
        </Show>

        <div class="px-4 py-3 space-y-2">
          <For each={rows()}>
            {(r) => (
              <div
                class={`rounded border px-2.5 py-1.5 ${
                  r.recall
                    ? 'border-orange-900/60 bg-orange-950/20'
                    : 'border-neutral-800 bg-neutral-900/40'
                }`}
              >
                <div class="flex items-baseline gap-2 mb-0.5">
                  <span class="text-[10px] font-mono text-neutral-500">#{r.i}</span>
                  <span
                    class={`text-[11px] font-mono ${
                      r.recall ? 'text-orange-300' : 'text-cyan-300'
                    }`}
                  >
                    {r.who}
                  </span>
                  <span class="text-[10px] text-neutral-600">{fmt(r.chars)} chars</span>
                  <Show when={r.media > 0}>
                    <span class="text-[10px] text-neutral-600">{r.media} media</span>
                  </Show>
                  <Show when={r.truncated}>
                    <span class="ml-auto text-[10px] font-mono text-neutral-600"
                          title="Bodies are truncated server-side; the full text is not sent.">
                      truncated
                    </span>
                  </Show>
                </div>
                <div
                  class="text-[12px] text-neutral-300 whitespace-pre-wrap break-words leading-relaxed"
                >
                  {r.body}{r.truncated ? ' …' : ''}
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
