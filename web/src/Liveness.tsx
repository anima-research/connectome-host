/**
 * Liveness strip — one always-visible line under the header answering
 * "is the MCPL link up, and is the agent actually answering?".
 *
 *   ● discord up · last msg 3m ago   ● agent last turn 2m ago
 *   ● discord DOWN · retry #4 failed 12m ago: handshake timeout
 *   ⚠ agent: messages unanswered for 9m
 *
 * The server re-sends the snapshot every heartbeat; if frames stop arriving
 * while the socket is still open, the host itself has gone quiet and we say so.
 */

import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { isBusy, LIVENESS_HEARTBEAT_MS, unansweredSince, type LivenessSnapshot } from '@conhost/web/liveness';

export interface LivenessState {
  snap: LivenessSnapshot;
  /** Client clock when the snapshot arrived. */
  receivedAt: number;
}

/** Three missed heartbeats → the host looks stuck. */
const QUIET_MS = 3 * LIVENESS_HEARTBEAT_MS;

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function LivenessStrip(props: { state: LivenessState | null; wireOpen: boolean }) {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    onCleanup(() => clearInterval(t));
  });

  // Snapshot times are server-clock; project "now" onto that clock so a
  // skewed viewer (phone, another machine) still gets correct ages.
  const serverNow = (): number => {
    const st = props.state!;
    return st.snap.at + (now() - st.receivedAt);
  };
  const age = (t: number | undefined): string =>
    t ? ago(serverNow() - t) : `never (since ${ago(serverNow() - props.state!.snap.since)})`;
  const quiet = (): boolean => props.wireOpen && now() - props.state!.receivedAt > QUIET_MS;

  const dot = (cls: string) => <span class={`inline-block w-2 h-2 rounded-full shrink-0 ${cls}`} />;

  return (
    <Show when={props.state}>
      {(st) => (
        <div class="border-b border-neutral-800 bg-neutral-950 px-4 py-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[11px] font-mono text-neutral-400">
          <For each={st().snap.servers}>{(s) => (
            <span class="flex items-center gap-1.5 min-w-0" title={s.lastError ? `last connect error: ${s.lastError.message}` : undefined}>
              {dot(s.connected ? 'bg-emerald-500' : s.retrying || s.lastError?.willRetry ? 'bg-amber-500' : 'bg-rose-500')}
              <span class="text-neutral-200">{s.id}</span>
              <Show when={s.connected} fallback={
                <span class="text-rose-300 truncate max-w-[32rem]">
                  DOWN
                  <Show when={s.lastError}>
                    {(e) => <> · {e().attempt > 0 ? `retry #${e().attempt}` : 'connect'} failed {ago(serverNow() - e().at)}: {e().message}</>}
                  </Show>
                </span>
              }>
                <span>up · last msg {age(s.lastInboundAt)}</span>
              </Show>
            </span>
          )}</For>
          <For each={st().snap.agents}>{(a) => {
            const unanswered = (): number | undefined => unansweredSince(a, serverNow());
            const busy = (): boolean => isBusy(a);
            const failedLast = (): boolean => !busy() && a.lastOutcome === 'failed';
            const stoppedLast = (): boolean => !busy() && a.lastOutcome === 'aborted';
            return (
              <span
                class={`flex items-center gap-1.5 ${unanswered() ? 'text-amber-300' : ''}`}
                title={a.lastFailure ? `last failure: ${a.lastFailure}` : undefined}
              >
                {dot(unanswered() ? 'bg-amber-500' : failedLast() ? 'bg-rose-500' : busy() ? 'bg-cyan-500' : 'bg-neutral-500')}
                <span class="text-neutral-200">{a.name}</span>
                <Show when={busy()} fallback={<span>last turn {age(a.lastEndedAt)}</span>}>
                  <span>thinking since {ago(serverNow() - a.lastStartedAt!)}</span>
                </Show>
                <Show when={failedLast()}><span class="text-rose-300">· failed</span></Show>
                <Show when={stoppedLast()}><span>· stopped</span></Show>
                <Show when={unanswered()}>
                  {(w) => <span>⚠ messages unanswered for {ago(serverNow() - w()).replace(' ago', '')}</span>}
                </Show>
              </span>
            );
          }}</For>
          <Show when={quiet()}>
            <span class="text-amber-300">⚠ host quiet — no update {ago(now() - st().receivedAt)}</span>
          </Show>
        </div>
      )}
    </Show>
  );
}
