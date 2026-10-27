import { createSignal, For, Show } from 'solid-js';

export interface PinRow {
  id: string;
  firstMessageId: string;
  lastMessageId: string;
  kind: 'pin' | 'document';
  name?: string;
  created: number;
  level?: number;
  maxLevel?: number;
}

export interface PinsState {
  agent: string;
  pins: PinRow[];
  pinsSupported: boolean;
  levelHonored: boolean;
  deepestLevel?: number;
  candidates?: PinCandidate[];
}

/**
 * MUST be a real message-store id: context-manager keeps a pin whatever ids it
 * names, so a pin naming no stored message matches nothing and silently does
 * nothing.
 */
export interface PinCandidate {
  id: string;
  index: number;
  participant: string;
  text: string;
}

const ago = (ms: number) => {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

function describe(p: PinRow): string {
  if (p.level !== undefined) return p.level === 0 ? 'at raw' : `at L${p.level}`;
  if (p.maxLevel !== undefined) return p.maxLevel === 0 ? 'raw (max L0)' : `max L${p.maxLevel}`;
  return 'raw';
}

export function PinsPanel(props: {
  loaded: boolean;
  state: PinsState | null;
  agent?: string;
  candidates?: PinCandidate[];
  onRefresh(): void;
  onAdd(input: {
    kind: 'pin' | 'document';
    firstMessageId: string;
    lastMessageId?: string;
    level?: number;
    maxLevel?: number;
    name?: string;
  }): void;
  onRemove(pinId: string): void;
}) {
  const [first, setFirst] = createSignal('');
  const [last, setLast] = createSignal('');
  const [name, setName] = createSignal('');
  const [mode, setMode] = createSignal<'raw' | 'max' | 'at'>('raw');
  const [lvl, setLvl] = createSignal('1');
  const [asDoc, setAsDoc] = createSignal(false);

  const [showPicker, setShowPicker] = createSignal(false);
  const [filter, setFilter] = createSignal('');

  const candidates = () => {
    const q = filter().trim().toLowerCase();
    const all = props.candidates ?? [];
    const hit = q ? all.filter((c) => c.text.toLowerCase().includes(q) || c.id.includes(q)) : all;
    return hit.slice(-200);
  };

  const submit = () => {
    const f = first().trim();
    if (!f) return;
    const n = Number(lvl());
    const levelOk = Number.isSafeInteger(n) && n >= 0 && n <= 32;
    props.onAdd({
      kind: asDoc() ? 'document' : 'pin',
      firstMessageId: f,
      ...(asDoc() || !last().trim() ? {} : { lastMessageId: last().trim() }),
      ...(mode() === 'at' && levelOk ? { level: n } : {}),
      ...(mode() === 'max' && levelOk ? { maxLevel: n } : {}),
      ...(name().trim() ? { name: name().trim() } : {}),
    });
    setFirst(''); setLast(''); setName('');
  };

  return (
    <div class="h-full overflow-y-auto px-3 py-2 text-xs">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold">pins</span>
        <Show when={props.state}>
          <span class="text-neutral-600 text-[10px]">{props.state!.pins.length}</span>
        </Show>
        <button
          type="button"
          class="ml-auto px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
          onClick={() => props.onRefresh()}
        >
          refresh
        </button>
      </div>

      <Show when={!props.loaded}><div class="text-neutral-600 italic">Loading…</div></Show>

      <Show when={props.state && !props.state.pinsSupported}>
        <div class="text-amber-400/80 text-[11px]">
          The active context strategy does not support pins.
        </div>
      </Show>

      <Show when={props.state?.pinsSupported}>
        <div class="text-[10px] text-neutral-600 mb-2 leading-relaxed">
          Pins constrain the fold plan and take effect on the <b>next compile</b> — no restart.
          They persist and are branch-scoped. Pair with a dry run to see the effect before it
          reaches a real turn.
        </div>

        <Show when={!props.state!.levelHonored}>
          <div class="mb-2 px-2 py-1 rounded bg-amber-950/40 border border-amber-800
                      text-[10px] text-amber-200 leading-relaxed">
            This agent is not on <span class="font-mono">kv-stable</span> folding, so
            <b> "at L<sub>k</sub>" degrades to raw</b> — a safe superset, but not what you asked
            for. Prefer <span class="font-mono">raw</span> or <span class="font-mono">max L</span>
            here.
          </div>
        </Show>

        <Show when={props.state!.pins.length === 0}>
          <div class="text-neutral-600 italic mb-3">No pins.</div>
        </Show>
        <Show when={props.state!.pins.length > 0}>
          <table class="w-full mb-3 font-mono text-[10px]">
            <tbody>
              <For each={props.state!.pins}>
                {(p) => (
                  <tr class="border-b border-neutral-900">
                    <td class="pr-1 align-top">
                      <span class={p.kind === 'document' ? 'text-indigo-300' : 'text-cyan-300'}>
                        {p.kind === 'document' ? 'doc' : 'pin'}
                      </span>
                    </td>
                    <td class="pr-1 align-top text-neutral-200">{describe(p)}</td>
                    <td class="pr-1 align-top text-neutral-400 break-all">
                      {p.firstMessageId}
                      <Show when={p.lastMessageId !== p.firstMessageId}>
                        <span class="text-neutral-600"> → {p.lastMessageId}</span>
                      </Show>
                      <Show when={p.name}>
                        <div class="text-neutral-500">“{p.name}”</div>
                      </Show>
                    </td>
                    <td class="pr-1 align-top text-neutral-600">{ago(p.created)}</td>
                    <td class="align-top text-right">
                      <button
                        type="button"
                        class="px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-red-900/60
                               text-neutral-400 hover:text-red-200"
                        title={`unpin ${p.id}`}
                        onClick={() => props.onRemove(p.id)}
                      >
                        unpin
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>

        <div class="border-t border-neutral-800 pt-2">
          <div class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold mb-1.5">
            add
          </div>

          <div class="space-y-1.5 mb-2">
            <label class="flex items-center gap-2">
              <span class="text-neutral-500 w-10">from</span>
              <input value={first()} onInput={(e) => setFirst(e.currentTarget.value)}
                placeholder="message id"
                class="flex-1 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5
                       font-mono text-[11px] text-neutral-100" />
            </label>
            <label class="flex items-center gap-2" title={asDoc() ? 'documents cover a single message' : ''}>
              <span class="text-neutral-500 w-10">to</span>
              <input value={last()} disabled={asDoc()}
                onInput={(e) => setLast(e.currentTarget.value)}
                placeholder={asDoc() ? 'n/a for documents' : 'optional — defaults to “from”'}
                class="flex-1 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5
                       font-mono text-[11px] text-neutral-100 disabled:opacity-40" />
            </label>
            <label class="flex items-center gap-2">
              <span class="text-neutral-500 w-10">label</span>
              <input value={name()} onInput={(e) => setName(e.currentTarget.value)}
                placeholder="optional"
                class="flex-1 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5
                       font-mono text-[11px] text-neutral-100" />
            </label>
          </div>

          <div class="flex items-center gap-3 mb-2 text-[10px] text-neutral-400 flex-wrap">
            <For each={[['raw', 'raw'], ['max', 'max L'], ['at', 'at L']] as Array<[string, string]>}>
              {([v, label]) => (
                <label class="flex items-center gap-1">
                  <input type="radio" name="pinmode" checked={mode() === v}
                    onChange={() => setMode(v as 'raw' | 'max' | 'at')} />
                  {label}
                </label>
              )}
            </For>
            <Show when={mode() !== 'raw'}>
              <input type="number" min="0" max={props.state!.deepestLevel ?? 8}
                value={lvl()} onInput={(e) => setLvl(e.currentTarget.value)}
                class="w-14 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5
                       font-mono text-[11px] text-neutral-100" />
              <Show when={props.state!.deepestLevel !== undefined}>
                <span class="text-neutral-600">deepest present: L{props.state!.deepestLevel}</span>
              </Show>
            </Show>
            <label class="flex items-center gap-1">
              <input type="checkbox" checked={asDoc()} onChange={(e) => setAsDoc(e.currentTarget.checked)} />
              as document
            </label>
          </div>

          <div class="flex items-center gap-2 mb-3">
            <button type="button" disabled={!first().trim()}
              class="px-2 py-0.5 text-[10px] rounded font-mono bg-cyan-900/50 hover:bg-cyan-900/70
                     text-cyan-200 disabled:opacity-30"
              onClick={submit}>
              add pin
            </button>
            <button type="button"
              class="px-2 py-0.5 text-[10px] rounded font-mono bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
              onClick={() => setShowPicker((v) => !v)}>
              {showPicker() ? 'hide messages' : `pick from messages (${(props.candidates ?? []).length})`}
            </button>
          </div>

          <Show when={showPicker()}>
            <input value={filter()} onInput={(e) => setFilter(e.currentTarget.value)}
              placeholder="filter by text or id"
              class="w-full mb-1 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5
                     font-mono text-[10px] text-neutral-100" />
            <Show when={candidates().length === 0}>
              <div class="text-[10px] text-neutral-600 italic">
                No pinnable messages loaded. Pins need a real store id, so only
                server-sourced rows qualify — scroll the chat to load history.
              </div>
            </Show>
            <div class="max-h-64 overflow-y-auto border border-neutral-800 rounded">
              <For each={candidates()}>
                {(c) => (
                  <div class="flex items-start gap-1.5 px-1.5 py-1 border-b border-neutral-900
                              hover:bg-neutral-900/60">
                    <span class="text-[9px] font-mono text-neutral-600 w-8 shrink-0">#{c.index}</span>
                    <span class="text-[9px] font-mono text-cyan-400/70 w-12 shrink-0 truncate">
                      {c.participant}
                    </span>
                    <span class="text-[10px] text-neutral-400 flex-1 truncate" title={c.text}>
                      {c.text.slice(0, 90)}
                    </span>
                    <button type="button"
                      class="text-[9px] font-mono px-1 rounded bg-neutral-800 hover:bg-neutral-700
                             text-neutral-400 shrink-0"
                      onClick={() => setFirst(c.id)}>from</button>
                    <button type="button" disabled={asDoc()}
                      class="text-[9px] font-mono px-1 rounded bg-neutral-800 hover:bg-neutral-700
                             text-neutral-400 shrink-0 disabled:opacity-30"
                      onClick={() => setLast(c.id)}>to</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
