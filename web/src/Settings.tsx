import { createSignal, Show, For } from 'solid-js';

export interface SettingsSnapshot {
  contextBudgetTokens: number;
  tailTokens?: number;
  transitionPaceTokens?: number;
  sameRoundThinkTextPolicy?: string;
  sameRoundThinkTextPolicySource?: string;
  transition: 'stable' | 'converging' | 'blocked';
  transitionReason?: string;
}

export interface SettingsState {
  agent: string;
  settings: SettingsSnapshot;
  overrides: string[];
  hotKeys: string[];
  hotConfigurable: boolean;
  previewAvailable: boolean;
}

/**
 * `preview.fits` from context-manager means "would not throw OverBudgetError",
 * which on a recipe with a grace ratio is NOT the same as "fits the budget you
 * typed".
 */
interface PreviewAccounting {
  requestedBudgetTokens: number;
  reserveForResponseTokens: number;
  effectiveBudgetTokens: number;
  rejectionBudgetTokens?: number;
  fitsRequested: boolean;
  withinGrace?: boolean;
  unreachable: boolean;
}

interface PreviewResult {
  finalTokens: number;
  budgetTokens: number;
  fits: boolean;
  exhausted: boolean;
  headTokens: number;
  tailTokens: number;
  middleTokens: number;
  middleChunkCount: number;
  deepestLevel: number;
  resolutions: Record<string, number>;
  appliedCount: number;
  producedCount: number;
}

const RESTART_ONLY = [
  'targetChunkTokens',
  'headWindowTokens',
  'mergeThreshold',
  'foldingStrategy',
  'maxSpeculativeL1s',
  'adaptiveResolution',
  'compressionSlackRatio',
];

const TRANSITION_HELP: Record<string, string> = {
  transition_pace_too_small:
    'the per-turn pace is below the floor — raise transitionPaceTokens or the descent cannot progress',
  protected_context_exceeds_target:
    'head + tail alone exceed the target — the verbatim window must shrink before this budget is reachable',
};

export function SettingsPanel(props: {
  loaded: boolean;
  state: SettingsState | null;
  scope?: string;
  onRefresh(): void;
  onApply(patch: {
    contextBudgetTokens?: number;
    tailTokens?: number;
    transitionPaceTokens?: number;
    immediate?: boolean;
    persist: boolean;
    notify: boolean;
  }): void;
  onReset(keys: string[] | undefined, persist: boolean): void;
  onCancelTransition(): void;
  onDryContext?(ctx: { entries: unknown[]; stats?: unknown; label: string }): void;
}) {
  const [budget, setBudget] = createSignal<string>('');
  const [tail, setTail] = createSignal<string>('');
  const [pace, setPace] = createSignal<string>('');
  const [persist, setPersist] = createSignal(true);
  const [notify, setNotify] = createSignal(false);
  const [immediate, setImmediate] = createSignal(false);

  const [preview, setPreview] = createSignal<PreviewResult | null>(null);
  const [acct, setAcct] = createSignal<PreviewAccounting | null>(null);
  const [previewErr, setPreviewErr] = createSignal<string | null>(null);
  const [previewing, setPreviewing] = createSignal(false);

  const [elapsed, setElapsed] = createSignal<number | null>(null);

  const s = () => props.state?.settings;
  const isHot = (k: string) => props.state?.hotKeys.includes(k) ?? false;

  const syncFromLive = () => {
    const cur = s();
    if (!cur) return;
    setBudget(String(cur.contextBudgetTokens));
    setTail(cur.tailTokens !== undefined ? String(cur.tailTokens) : '');
    setPace(cur.transitionPaceTokens !== undefined ? String(cur.transitionPaceTokens) : '');
  };

  const num = (v: string): number | undefined => {
    if (v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };

  /**
   * Not wired to input events: a dry run is a real compile, and
   * context-manager's previewContext runs synchronously, so the host's event
   * loop, and the agent with it, waits while it runs.
   */
  const runDryRun = async (render: boolean) => {
    if (!props.state?.previewAvailable || previewing()) return;
    const b = num(budget());
    if (b === undefined) { setPreviewErr('budget must be a positive integer'); return; }
    setPreviewing(true);
    setPreviewErr(null);
    setElapsed(null);
    try {
      const qs = new URLSearchParams({ budget: String(b), agent: props.state!.agent });
      if (props.scope && props.scope !== 'local') qs.set('scope', props.scope);
      const t = num(tail());
      if (t !== undefined) qs.set('tail', String(t));
      if (render) qs.set('render', '1');
      const res = await fetch(`/debug/context/preview?${qs}`, { credentials: 'same-origin' });
      const body = await res.json();
      if (!res.ok) {
        setPreview(null);
        setAcct(null);
        setPreviewErr(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setPreview(body.preview as PreviewResult);
      setAcct((body.accounting ?? null) as PreviewAccounting | null);
      setElapsed(typeof body.elapsedMs === 'number' ? body.elapsedMs : null);
      if (render && body.preview?.entries) {
        props.onDryContext?.({
          entries: body.preview.entries,
          stats: body.preview.stats,
          label: `budget ${b.toLocaleString()}${t !== undefined ? `, tail ${t.toLocaleString()}` : ''}`,
        });
      }
    } catch (e) {
      setPreview(null);
      setAcct(null);
      setPreviewErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  };

  const apply = () => {
    const patch: Record<string, number> = {};
    const b = num(budget());
    const t = num(tail());
    const p = num(pace());
    const cur = s();
    if (b !== undefined && b !== cur?.contextBudgetTokens) patch.contextBudgetTokens = b;
    if (t !== undefined && t !== cur?.tailTokens) patch.tailTokens = t;
    if (p !== undefined && p !== cur?.transitionPaceTokens) patch.transitionPaceTokens = p;
    if (Object.keys(patch).length === 0) return;
    props.onApply({
      ...patch,
      ...(lowering() && immediate() ? { immediate: true } : {}),
      persist: persist(),
      notify: notify(),
    });
  };

  const lowering = () => {
    const b = num(budget());
    const cur = s();
    return b !== undefined && cur !== undefined && b < cur.contextBudgetTokens;
  };

  const dirty = () => {
    const cur = s();
    if (!cur) return false;
    const b = num(budget()), t = num(tail()), p = num(pace());
    return (b !== undefined && b !== cur.contextBudgetTokens)
      || (t !== undefined && t !== cur.tailTokens)
      || (p !== undefined && p !== cur.transitionPaceTokens);
  };

  return (
    <div class="h-full overflow-y-auto px-3 py-2 text-xs">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold">
          context settings
        </span>
        <Show when={props.state}>
          <span class="text-neutral-600 text-[10px] font-mono">{props.state!.agent}</span>
        </Show>
        <button
          type="button"
          class="ml-auto px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
          onClick={() => { props.onRefresh(); setTimeout(syncFromLive, 150); }}
        >
          refresh
        </button>
      </div>

      <Show when={!props.loaded}>
        <div class="text-neutral-600 italic">Loading…</div>
      </Show>

      <Show when={props.loaded && !props.state}>
        <div class="text-amber-400/80">Runtime settings unavailable on this build.</div>
      </Show>

      <Show when={props.state}>
        <Show when={s()!.transition !== 'stable'}>
          <div
            class={`mb-2 px-2 py-1.5 rounded border text-[11px] ${
              s()!.transition === 'blocked'
                ? 'bg-red-950/40 border-red-800 text-red-300'
                : 'bg-amber-950/40 border-amber-800 text-amber-200'
            }`}
          >
            <div class="font-semibold">
              {s()!.transition === 'blocked' ? 'descent BLOCKED' : 'descent converging'}
            </div>
            <Show when={s()!.transitionReason}>
              <div class="mt-0.5 text-[10px] opacity-90">
                {TRANSITION_HELP[s()!.transitionReason!] ?? s()!.transitionReason}
              </div>
            </Show>
            <button
              type="button"
              class="mt-1 px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded font-mono"
              onClick={() => props.onCancelTransition()}
            >
              cancel transition (hold current frontier)
            </button>
          </div>
        </Show>

        <Show when={!props.state!.hotConfigurable}>
          <div class="mb-2 px-2 py-1 rounded bg-neutral-900 border border-neutral-800 text-[10px] text-neutral-400">
            This strategy is not hot-configurable — only the budget can be changed live.
          </div>
        </Show>

        <table class="w-full mb-3 font-mono text-[11px]">
          <tbody>
            <For each={[
              ['contextBudgetTokens', s()!.contextBudgetTokens],
              ['tailTokens', s()!.tailTokens],
              ['transitionPaceTokens', s()!.transitionPaceTokens],
              ['sameRoundThinkTextPolicy', s()!.sameRoundThinkTextPolicy],
            ] as Array<[string, unknown]>}>
              {([k, v]) => (
                <tr>
                  <td class="text-neutral-500 pr-2">{k}</td>
                  <td class="text-neutral-200 text-right tabular-nums">
                    {v === undefined ? '–' : String(v)}
                  </td>
                  <td class="pl-2 w-16">
                    <Show when={props.state!.overrides.includes(k)}>
                      <span class="text-[9px] px-1 rounded bg-cyan-900/50 text-cyan-300">override</span>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>

        <div class="space-y-1.5 mb-2">
          <For each={[
            ['budget', 'contextBudgetTokens', budget, setBudget] as const,
            ['tail', 'tailTokens', tail, setTail] as const,
            ['pace', 'transitionPaceTokens', pace, setPace] as const,
          ]}>
            {([label, key, get, set]) => (
              <label class="flex items-center gap-2">
                <span class="text-neutral-500 w-12">{label}</span>
                <input
                  type="number"
                  disabled={!isHot(key)}
                  value={get()}
                  placeholder={isHot(key) ? 'tokens' : 'restart only'}
                  onInput={(e) => set(e.currentTarget.value)}
                  class="flex-1 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5
                         font-mono text-[11px] text-neutral-100 disabled:opacity-40"
                />
              </label>
            )}
          </For>
        </div>

        <div class="flex items-center gap-3 mb-2 text-[10px] text-neutral-400">
          <label class="flex items-center gap-1">
            <input type="checkbox" checked={persist()} onChange={(e) => setPersist(e.currentTarget.checked)} />
            persist
          </label>
          <label class="flex items-center gap-1" title="Injects a notice into the agent's context. This perturbs the very context being tuned — it invalidates the KV prefix and is classifier-visible. The agent can always read settings itself via agent_settings.">
            <input type="checkbox" checked={notify()} onChange={(e) => setNotify(e.currentTarget.checked)} />
            notify agent
          </label>
        </div>
        <div class="text-[10px] text-neutral-600 mb-2 leading-relaxed">
          <Show when={!persist()}>
            <div>ephemeral — live now, reverts on restart.</div>
          </Show>
          <Show when={lowering()}>
            <label
              class="flex items-center gap-1 text-neutral-400 mb-1"
              title="Skip the paced descent: the next compile plans straight at the new budget. The whole fold-down and its KV-prefix invalidation land on that one turn — the emergency lever for refusal streaks or over-budget wedges. Cancels any in-flight descent."
            >
              <input type="checkbox" checked={immediate()} onChange={(e) => setImmediate(e.currentTarget.checked)} />
              drop immediately
            </label>
            <Show when={!immediate()}>
              <div class="text-amber-500/90">
                lowering the budget converges gradually, not instantly — it will report
                <span class="font-mono"> converging</span> until it settles.
                Check <span class="font-mono">drop immediately</span> to skip the descent.
              </div>
            </Show>
            <Show when={immediate()}>
              <div class="text-red-400/90">
                immediate drop: the full fold-down (and its KV re-read) lands on the next
                turn, and any in-flight descent is cancelled.
              </div>
            </Show>
          </Show>
        </div>

        <div class="flex items-center gap-2 mb-3">
          <button
            type="button"
            disabled={!dirty()}
            class="px-2 py-0.5 text-[10px] rounded font-mono bg-cyan-900/50 hover:bg-cyan-900/70
                   text-cyan-200 disabled:opacity-30 disabled:hover:bg-cyan-900/50"
            onClick={apply}
          >
            apply
          </button>
          <button
            type="button"
            class="px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
            onClick={() => { props.onReset(undefined, persist()); setTimeout(syncFromLive, 200); }}
          >
            reset to recipe
          </button>
          <button
            type="button"
            class="px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
            onClick={syncFromLive}
          >
            revert edits
          </button>
        </div>

        <div class="border-t border-neutral-800 pt-2">
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <span class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold">
              dry run
            </span>
            <button
              type="button"
              disabled={previewing() || !props.state!.previewAvailable}
              class="px-2 py-0.5 text-[10px] rounded font-mono bg-neutral-800 hover:bg-neutral-700
                     text-neutral-200 disabled:opacity-30"
              onClick={() => void runDryRun(false)}
              title="Compile at these settings without applying them. Does not commit anything. ~1.6s on a large store after the 2026-07-26 solver fixes."
            >
              dry run
            </button>
            <button
              type="button"
              disabled={previewing() || !props.state!.previewAvailable}
              class="px-2 py-0.5 text-[10px] rounded font-mono bg-cyan-900/40 hover:bg-cyan-900/60
                     text-cyan-200 disabled:opacity-30"
              onClick={() => void runDryRun(true)}
              title="Dry run, and show the resulting context in the main pane. Costs more than a plain dry run — bodies are truncated server-side to keep it close."
            >
              dry run + show context
            </button>
            <Show when={previewing()}>
              <span class="text-amber-400/90 text-[10px]">running — agent paused…</span>
            </Show>
            <Show when={!previewing() && elapsed() !== null}>
              <span class="text-neutral-600 text-[10px]">{(elapsed()! / 1000).toFixed(1)}s</span>
            </Show>
          </div>
          <div class="text-[10px] text-neutral-600 mb-1.5 leading-relaxed">
            A dry run is a <b class="text-neutral-500">full compile</b> and it runs on the agent's
            thread — while it runs the agent does nothing else (no heartbeat, no Discord, no MCPL).
            Measured ~1.6s on a large store; it commits nothing (no fold resolutions, no compression
            queued). Runs are serialized with a short cooldown, so a second click is refused rather
            than queueing another pause.
          </div>

          <Show when={!props.state!.previewAvailable}>
            <div class="text-[10px] text-neutral-500 leading-relaxed">
              Preview unavailable on this build — the resolved context-manager has no
              dry-run support. Apply still works; you just won't see the plan first.
            </div>
          </Show>

          <Show when={props.state!.previewAvailable && previewErr()}>
            <div class="text-[10px] text-amber-400/90">{previewErr()}</div>
          </Show>

          <Show when={preview()}>
            {(p) => (
              <div>
                <div
                  class={`px-2 py-1 rounded mb-1.5 text-[11px] border ${
                    acct()?.fitsRequested
                      ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
                      : acct()?.withinGrace
                        ? 'bg-amber-950/40 border-amber-800 text-amber-200'
                        : 'bg-red-950/40 border-red-800 text-red-300'
                  }`}
                >
                  <Show when={acct()?.fitsRequested}>
                    <div>
                      fits — {p().finalTokens.toLocaleString()} of{' '}
                      {acct()!.effectiveBudgetTokens.toLocaleString()} usable tok
                    </div>
                  </Show>
                  <Show when={!acct()?.fitsRequested && acct()?.withinGrace}>
                    <div>
                      OVER REQUESTED BUDGET — {p().finalTokens.toLocaleString()} tok vs{' '}
                      {acct()!.effectiveBudgetTokens.toLocaleString()} usable
                    </div>
                    <div class="text-[10px] opacity-90 mt-0.5">
                      it would not hard-fail, but only because the grace margin absorbs the
                      overshoot (ceiling {acct()!.rejectionBudgetTokens?.toLocaleString()}).
                      The context would run above your target indefinitely.
                    </div>
                  </Show>
                  <Show when={acct() && !acct()!.fitsRequested && acct()!.withinGrace === false}>
                    <div>
                      WOULD HARD-FAIL — {p().finalTokens.toLocaleString()} tok exceeds even the
                      grace ceiling {acct()!.rejectionBudgetTokens?.toLocaleString()}
                    </div>
                  </Show>
                  <Show when={acct()?.unreachable}>
                    <div class="text-[10px] opacity-90 mt-0.5">
                      <b>unreachable:</b> the picker exhausted — nothing further can be folded,
                      so this budget cannot be reached no matter how long you wait.
                    </div>
                  </Show>
                </div>

                <table class="w-full font-mono text-[10px]">
                  <tbody>
                    <For each={[
                      ['requested budget', acct()?.requestedBudgetTokens],
                      ['− reserve for response', acct()?.reserveForResponseTokens],
                      ['= usable for context', acct()?.effectiveBudgetTokens],
                      ['grace ceiling (hard fail above)', acct()?.rejectionBudgetTokens],
                      ['head (verbatim)', p().headTokens],
                      ['tail (verbatim)', p().tailTokens],
                      ['middle (foldable)', p().middleTokens],
                      ['middle messages (picker units)', p().middleChunkCount],
                      ['deepest fold level', `L${p().deepestLevel}`],
                      ['folds applied', p().appliedCount],
                    ] as Array<[string, unknown]>}>
                      {([k, v]) => (
                        <tr>
                          <td class="text-neutral-500 pr-2">{k}</td>
                          <td class="text-neutral-300 text-right tabular-nums">
                            {typeof v === 'number'
                              ? v.toLocaleString()
                              : v === undefined || v === null
                                ? '–'
                                : String(v)}
                          </td>
                        </tr>
                      )}
                    </For>
                    <tr>
                      <td class="text-neutral-500 pr-2">summaries to produce</td>
                      <td
                        class={`text-right tabular-nums ${
                          p().producedCount > 0 ? 'text-amber-400' : 'text-neutral-300'
                        }`}
                      >
                        {p().producedCount}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <Show when={p().producedCount > 0}>
                  <div class="text-[10px] text-amber-500/80 mt-1 leading-relaxed">
                    {p().producedCount} summar{p().producedCount === 1 ? 'y' : 'ies'} do not exist
                    yet — reaching this layout costs that many compression calls first.
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </div>

        <div class="border-t border-neutral-800 mt-3 pt-2">
          <div class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold mb-1">
            restart only
          </div>
          <div class="text-[10px] text-neutral-600 leading-relaxed">
            These come from the recipe and are read at construction — changing them needs a
            restart, not this panel:
            <span class="font-mono text-neutral-500"> {RESTART_ONLY.join(', ')}</span>
          </div>
        </div>
      </Show>
    </div>
  );
}
