/**
 * Live operator surgery UI — the pieces the chat/context views and header
 * mount when the host advertises them in `welcome.features`:
 *
 *   - MediaView       inline image (lazy `/media/<ref>`) with a lightbox
 *   - HostModeToggle  quiesce / resume switch showing the host's serving state
 *   - SurgeryDialog   confirm + note for a rollback or suppression; shows the
 *                     result, and offers "quiesce, then retry" on agent-busy
 *   - SelectionBar    floating bar while messages are being selected to suppress
 *   - OperatorLogList the durable operator-actions record, newest first
 *   - AwarenessList   the framework's Discord awareness-marks journal, with
 *                     cancel / retract / release
 *
 * Every mutation goes through the server (`rollback` / `suppress` /
 * `host-quiesce` / `host-resume` frames); nothing here touches state directly.
 */

import { createSignal, For, Show } from 'solid-js';
import type {
  AwarenessEntryWire,
  HostModeSnapshot,
  OperatorLogEntryWire,
  SurgeryMarkerReceiptWire,
  SurgeryMarksPreviewWire,
  SurgeryResultMessage,
} from '@conhost/web/protocol';

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const [lightbox, setLightbox] = createSignal<{ src: string; label: string } | null>(null);

/** Full-screen viewer for whichever image was clicked. Mount once at app root. */
export function Lightbox() {
  return (
    <Show when={lightbox()}>
      {(img) => (
        <div
          class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm cursor-zoom-out"
          onClick={() => setLightbox(null)}
        >
          <img src={img().src} alt={img().label} class="max-w-[95vw] max-h-[90vh] object-contain rounded shadow-2xl" />
          <div class="mt-2 text-[11px] font-mono text-neutral-400">{img().label} · click to close</div>
        </div>
      )}
    </Show>
  );
}

/**
 * One media block. With a `ref` (or an inline data URL) it renders the image
 * lazily and opens the lightbox on click; otherwise it stays the type chip the
 * UI always showed (documents, audio, stripped images).
 */
export function MediaView(props: {
  mediaType: string;
  /** Host media locator (`<messageId>/<blockPath>`), served at /media/. */
  mediaRef?: string;
  /** Already-inline image (context document ships base64) — a data: URL. */
  dataUrl?: string;
  /** Query suffix routing /media to a fleet child, e.g. `?scope=miner`. */
  scopeQuery?: string;
  compact?: boolean;
}) {
  const [failed, setFailed] = createSignal(false);
  const src = (): string | null => {
    if (props.dataUrl) return props.dataUrl;
    if (props.mediaRef && props.mediaType.startsWith('image/')) return `/media/${props.mediaRef}${props.scopeQuery ?? ''}`;
    return null;
  };
  return (
    <Show when={src() && !failed()} fallback={
      <div class="my-1 inline-block mr-1 text-[11px] font-mono text-sky-400/80 bg-sky-950/20 border border-sky-900/40 rounded px-2 py-0.5"
        title={failed() ? 'image could not be loaded (stripped, reference-only, or gone from this branch)' : undefined}>
        📎 {props.mediaType}{failed() ? ' · unavailable' : ''}
      </div>
    }>
      <button
        type="button"
        class="my-1 mr-1 inline-block align-top rounded border border-neutral-800 bg-neutral-900/40 overflow-hidden cursor-zoom-in hover:border-sky-800 focus:outline-none focus:ring-1 focus:ring-sky-700"
        title={`${props.mediaType} — click to enlarge`}
        onClick={() => setLightbox({ src: src()!, label: props.mediaType })}
      >
        <img
          src={src()!}
          alt={props.mediaType}
          loading="lazy"
          decoding="async"
          class={`block object-contain ${props.compact ? 'max-h-32 max-w-[14rem]' : 'max-h-64 max-w-md'}`}
          onError={() => setFailed(true)}
        />
      </button>
    </Show>
  );
}

// ---------------------------------------------------------------------------
// Host mode (quiesce)
// ---------------------------------------------------------------------------

const fmtSince = (ts?: number): string => {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${(m / 60).toFixed(1)}h ago`;
};

/** Header switch: serving ⇄ quiesced. Disabled for observers and while a
 *  transition is in flight. */
export function HostModeToggle(props: {
  hostMode: HostModeSnapshot | null;
  busy: boolean;
  readOnly: boolean;
  onQuiesce(reason: string): void;
  onResume(): void;
}) {
  const [asking, setAsking] = createSignal(false);
  const [reason, setReason] = createSignal('');
  const mode = (): string => props.hostMode?.mode ?? 'unknown';
  const quiesced = (): boolean => mode() === 'quiesced';
  const transitional = (): boolean => mode() === 'quiescing' || mode() === 'resuming' || props.busy;
  const color = (): string =>
    quiesced() ? 'text-amber-200 bg-amber-950/50 border-amber-800'
    : transitional() ? 'text-amber-300 bg-neutral-900 border-amber-900 animate-pulse'
    : 'text-emerald-300 bg-neutral-900 border-neutral-800 hover:border-neutral-600';
  const label = (): string =>
    quiesced() ? '⏸ quiesced' : mode() === 'quiescing' ? '⏳ quiescing' : mode() === 'resuming' ? '⏳ resuming' : '● serving';
  const tip = (): string => {
    const hm = props.hostMode;
    if (!hm) return 'host mode unknown';
    const parts = [`host ${hm.mode}`];
    if (hm.since) parts.push(fmtSince(hm.since));
    if (hm.reason) parts.push(`reason: ${hm.reason}`);
    if (typeof hm.activeTurns === 'number' && hm.activeTurns > 0) parts.push(`${hm.activeTurns} turn(s) draining`);
    parts.push(props.readOnly ? '(read-only)' : quiesced() ? 'click to resume serving' : 'click to quiesce (drain turns, hold wakes)');
    return parts.join(' · ');
  };
  return (
    <div class="relative">
      <button
        type="button"
        class={`text-[11px] font-mono px-1.5 py-0.5 rounded border ${color()} disabled:opacity-60 disabled:cursor-default`}
        title={tip()}
        disabled={props.readOnly || transitional()}
        onClick={() => { if (quiesced()) props.onResume(); else setAsking((v) => !v); }}
      >
        {label()}
      </button>
      <Show when={asking()}>
        <div class="absolute left-0 top-full mt-1 z-40 w-72 bg-neutral-900 border border-neutral-700 rounded shadow-xl p-2 text-xs">
          <div class="text-amber-200 font-semibold mb-1">Quiesce host</div>
          <div class="text-neutral-400 mb-2 leading-snug">
            Finishes in-flight turns, then holds every wake (Discord, heartbeat, timers) until resumed.
            Compression and maintenance keep running. Rollback/suppress need an idle agent — this gets you one.
          </div>
          <input
            class="w-full bg-neutral-950 border border-neutral-800 rounded px-2 py-1 font-mono text-[11px] text-neutral-200 mb-2"
            placeholder="reason (recorded in the operator log)"
            value={reason()}
            onInput={(e) => setReason(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { props.onQuiesce(reason()); setAsking(false); } if (e.key === 'Escape') setAsking(false); }}
          />
          <div class="flex gap-1 justify-end">
            <button type="button" class="px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700" onClick={() => setAsking(false)}>cancel</button>
            <button type="button" class="px-2 py-0.5 rounded bg-amber-900/50 hover:bg-amber-900/80 text-amber-100"
              onClick={() => { props.onQuiesce(reason()); setAsking(false); }}>quiesce</button>
          </div>
        </div>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rollback / suppress dialog
// ---------------------------------------------------------------------------

export interface SurgeryRequest {
  op: 'rollback' | 'suppress';
  /** Rollback: the message that becomes the new tail. Suppress: the messages to redact. */
  messageIds: string[];
  /** Human preview lines for the dialog (participant + first words). */
  previews: string[];
  /** Rollback only: how many messages leave the live branch. */
  affected?: number;
}

/** The operator's awareness-marks choice in the dialog. */
export type MarksChoice = 'none' | 'addressed' | 'all';

export function SurgeryDialog(props: {
  request: SurgeryRequest;
  pending: boolean;
  result: SurgeryResultMessage | null;
  canQuiesce: boolean;
  hostMode: HostModeSnapshot | null;
  /** The framework takes an explicit marks choice ('marks' feature). */
  marksSupported: boolean;
  /** An older framework that marks every removed Discord message itself:
   *  live surgery is refused there, so the dialog can't proceed. */
  legacyMarking: boolean;
  /** The session or branch changed since this dialog opened: its preview no
   *  longer describes what confirming would do. */
  stale: boolean;
  preview: SurgeryMarksPreviewWire | null;
  previewError: string | null;
  marks: MarksChoice;
  onMarks(choice: MarksChoice): void;
  onConfirm(note: string): void;
  onQuiesceAndRetry(note: string): void;
  onClose(): void;
}) {
  const [note, setNote] = createSignal('');
  const isRollback = () => props.request.op === 'rollback';
  const title = () => isRollback() ? 'Roll back the live branch' : `Suppress ${props.request.messageIds.length} message${props.request.messageIds.length === 1 ? '' : 's'}`;
  const busy = () => props.result?.ok === false && props.result.code === 'agent-busy';
  /** An older framework marks regardless of any choice: the host refuses. */
  /** Every live surgery is preview-bound: confirming needs the preview. */
  const blocked = () => props.legacyMarking || props.stale || (props.marksSupported && !props.preview?.context);
  const confirm = (): void => { if (!props.pending && !blocked()) props.onConfirm(note()); };
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => { if (!props.pending) props.onClose(); }}>
      <div class="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl max-w-lg w-full mx-4 p-5" onClick={(e) => e.stopPropagation()}>
        <div class={`text-sm font-semibold mb-2 ${isRollback() ? 'text-amber-300' : 'text-rose-300'}`}>{title()}</div>

        <Show when={!props.result}>
          <p class="text-neutral-300 text-sm mb-2 leading-snug">
            {isRollback()
              ? <>The chronicle forks at this message and the fork becomes the live branch — the {props.request.affected ?? '?'} message{props.request.affected === 1 ? '' : 's'} after it stay on the current branch and leave the agent's context. Nothing is deleted; checkout the parent branch to restore.</>
              : <>The chronicle forks at the current head, these messages are redacted on the fork, and the fork becomes the live branch. The current branch keeps them. Already-folded summaries are not rewritten.</>}
          </p>
          <ul class="text-xs font-mono text-neutral-400 mb-3 space-y-0.5 max-h-40 overflow-y-auto border border-neutral-800 rounded p-2">
            <For each={props.request.previews}>{(p) => <li class="truncate">· {p}</li>}</For>
          </ul>
          <input
            class="w-full bg-neutral-950 border border-neutral-800 rounded px-2 py-1 font-mono text-xs text-neutral-200 mb-3"
            placeholder="reason (optional — goes in the operator log)"
            value={note()}
            onInput={(e) => setNote(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
          />
          <Show when={props.stale}>
            <div class="text-[11px] text-amber-300/90 border border-amber-900/60 rounded p-2 mb-3 leading-snug">
              The live session or branch changed since this dialog opened, so what it shows no longer describes what confirming would do.
              Close it and start again from the current branch.
            </div>
          </Show>
          <MarksChooser
            supported={props.marksSupported}
            legacy={props.legacyMarking}
            preview={props.preview}
            error={props.previewError}
            marks={props.marks}
            disabled={props.pending}
            onMarks={props.onMarks}
          />
          <Show when={props.hostMode && props.hostMode.mode !== 'quiesced'}>
            <div class="text-[11px] text-neutral-500 mb-3">
              Host is <span class="text-neutral-300">{props.hostMode!.mode}</span>. The framework refuses while the agent is mid-turn; if that happens you can quiesce first.
            </div>
          </Show>
          <div class="flex gap-2 justify-end">
            <button type="button" class="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm" disabled={props.pending} onClick={props.onClose}>Cancel</button>
            <button type="button"
              class={`px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-60 ${isRollback() ? 'bg-amber-900/50 hover:bg-amber-900/80 text-amber-100' : 'bg-rose-900/50 hover:bg-rose-900/80 text-rose-100'}`}
              disabled={props.pending || blocked()}
              onClick={confirm}>
              {props.pending ? 'working…' : isRollback() ? 'Roll back' : 'Suppress'}
            </button>
          </div>
        </Show>

        <Show when={props.result}>
          {(r) => (
            <>
              <Show when={r().ok} fallback={
                <div class="text-sm text-rose-300 mb-3 font-mono whitespace-pre-wrap">{r().error ?? 'failed'}</div>
              }>
                <div class="text-sm text-emerald-300 mb-1">Done — {r().messagesRemoved ?? 0} message{r().messagesRemoved === 1 ? '' : 's'} left the live context.</div>
                <div class="text-xs font-mono text-neutral-400 mb-1">now on <span class="text-cyan-300">{r().targetBranch}</span> · was {r().sourceBranch}</div>
                <Show when={r().lastVisible?.preview}>
                  <div class="text-xs text-neutral-500 mb-3 truncate">last visible: <span class="text-neutral-300">{r().lastVisible!.participant ?? r().lastVisible!.role ?? ''}</span> — {r().lastVisible!.preview}</div>
                </Show>
                <Show when={r().markers}>{(m) => <MarkersReceipt markers={m()} />}</Show>
              </Show>
              <div class="flex gap-2 justify-end">
                <Show when={busy() && props.canQuiesce}>
                  <button type="button" class="px-3 py-1.5 rounded bg-amber-900/50 hover:bg-amber-900/80 text-amber-100 text-sm" disabled={props.pending}
                    onClick={() => props.onQuiesceAndRetry(note())}>
                    {props.pending ? 'quiescing…' : 'Quiesce, then retry'}
                  </button>
                </Show>
                <button type="button" class="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm" onClick={props.onClose}>Close</button>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

/**
 * The awareness-marks choice: whether the people whose Discord messages this
 * change removes see a 💤 reaction. Default none: the change stays local to
 * the agent. A scope can only be chosen once the preview has said what it
 * covers, and the choice is bound to exactly the previewed messages.
 */
function MarksChooser(props: {
  supported: boolean;
  legacy: boolean;
  preview: SurgeryMarksPreviewWire | null;
  error: string | null;
  marks: MarksChoice;
  disabled: boolean;
  onMarks(choice: MarksChoice): void;
}) {
  const channels = (list: Array<{ channelId: string; count: number }>): string =>
    list.map((c) => `${c.channelId.split(':').at(-1)} ×${c.count}`).join(', ');
  const option = (choice: MarksChoice, label: string, detail?: string, enabled = true) => (
    <label class={`flex items-start gap-2 text-xs ${enabled ? 'text-neutral-300 cursor-pointer' : 'text-neutral-600'}`}>
      <input type="radio" name="marks" class="mt-0.5" checked={props.marks === choice}
        disabled={props.disabled || !enabled} onChange={() => props.onMarks(choice)} />
      <span>{label}<Show when={detail}><span class="block text-[10px] text-neutral-500 font-mono truncate">{detail}</span></Show></span>
    </label>
  );
  return (
    <>
      <Show when={props.legacy}>
        <div class="text-[11px] text-amber-300/90 border border-amber-900/60 rounded p-2 mb-3 leading-snug">
          Live surgery is unavailable on this host: its agent-framework would place 💤 on every removed Discord message it can address,
          other people's included, whatever is chosen here. Upgrade @animalabs/agent-framework to make marks a choice.
        </div>
      </Show>
      <Show when={props.supported}>
        <div class="border border-neutral-800 rounded p-2 mb-3 space-y-1">
          <div class="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">Discord awareness marks</div>
          <Show when={!props.error} fallback={<div class="text-[11px] text-rose-300">preview failed: {props.error} — this change can't be confirmed without its preview</div>}>
            <Show when={props.preview} fallback={<div class="text-[11px] text-neutral-500 italic">checking what this removes (confirming waits for it)…</div>}>
              {(p) => (
                <>
                  <div class="text-[11px] text-neutral-400">
                    Removes {p().messagesRemoved} message{p().messagesRemoved === 1 ? '' : 's'}; {p().addressable} carr{p().addressable === 1 ? 'ies' : 'y'} a Discord address.
                  </div>
                  {option('none', "Don't mark: the change stays local to the agent")}
                  {option('addressed', `Mark the ${p().scopes.addressed.count} that addressed the agent (mentions, replies, DMs) with ${p().emoji}`,
                    channels(p().scopes.addressed.channels), p().scopes.addressed.count > 0)}
                  {option('all', `Mark all ${p().scopes.all.count} with ${p().emoji}`,
                    channels(p().scopes.all.channels), p().scopes.all.count > 0)}
                  <div class="text-[10px] text-neutral-500 leading-snug">
                    Marks are reactions the bot posts where people can see them. Only the messages previewed here are marked; delivery runs in the background.
                    A mark stays on Discord until it is retracted: <span class="text-neutral-400">cancel</span> only stops marks not yet sent;
                    <span class="text-neutral-400">retract</span> asks Discord to remove the bot's marks. Both are in the branch panel's awareness list.
                  </div>
                </>
              )}
            </Show>
          </Show>
        </div>
      </Show>
    </>
  );
}

/** What the framework reports about a surgery's marks: scheduling, never Discord acceptance. */
function MarkersReceipt(props: { markers: SurgeryMarkerReceiptWire }) {
  const m = () => props.markers;
  const unmarked = () => (m().unmarked ? `; ${m().unmarked} removed Discord message${m().unmarked === 1 ? '' : 's'} left unmarked` : '');
  const notRemoved = () => (m().notRemoved ? `; ${m().notRemoved} previewed but not removed` : '');
  return (
    <div class={`text-xs mb-3 leading-snug ${m().status === 'not-scheduled' ? 'text-rose-300' : m().status === 'unresolved' ? 'text-amber-300' : 'text-neutral-400'}`}>
      <Show when={m().status === 'none'}>No Discord marks{unmarked()}{notRemoved()}.</Show>
      <Show when={m().status === 'queued'}>
        Marks: {m().queued} queued{m().scope ? ` (${m().scope})` : ''}{unmarked()}{notRemoved()}. Delivery runs in the background.
        In the branch panel's awareness list, cancel stops marks not yet sent; marks already placed stay until you retract them.
      </Show>
      <Show when={m().status === 'not-scheduled'}>Marks were not scheduled and will not be sent: {m().error}</Show>
      <Show when={m().status === 'unresolved'}>
        Marks bookkeeping is unresolved for batch {m().batchId}: {m().error}. It may still be delivered; cancel it from the awareness list.
      </Show>
    </div>
  );
}

/** Floating bar shown while selecting messages to suppress. */
export function SelectionBar(props: { count: number; onSuppress(): void; onClear(): void }) {
  return (
    <div class="sticky bottom-2 z-20 mx-auto w-fit flex items-center gap-3 bg-neutral-900/95 border border-rose-900/60 rounded-full px-4 py-1.5 shadow-xl text-xs font-mono">
      <span class="text-rose-200">{props.count} selected</span>
      <button type="button" class="px-2 py-0.5 rounded bg-rose-900/50 hover:bg-rose-900/80 text-rose-100 disabled:opacity-50" disabled={props.count === 0} onClick={props.onSuppress}>suppress</button>
      <button type="button" class="px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300" onClick={props.onClear}>done</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Operator log
// ---------------------------------------------------------------------------

const fmtAt = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = d.toDateString() === new Date().toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
};

const kindColor = (kind: string): string =>
  kind === 'rollback' || kind === 'undo-turn' || kind === 'redo-turn' ? 'text-amber-300'
  : kind === 'suppress' || kind === 'hide' ? 'text-rose-300'
  : kind === 'quiesce' || kind === 'resume' ? 'text-sky-300'
  : 'text-neutral-300';

function summarize(e: OperatorLogEntryWire): string {
  const r = e.result ?? {};
  const p = e.params ?? {};
  switch (e.kind) {
    case 'rollback': return `→ ${String(r.targetBranch ?? '?')} (−${String(r.messagesRemoved ?? '?')} msgs)`;
    case 'suppress': return `→ ${String(r.targetBranch ?? '?')} (−${String(r.messagesRemoved ?? (Array.isArray(p.messageIds) ? p.messageIds.length : '?'))} msgs)`;
    case 'undo-turn': case 'redo-turn': return `→ ${String(r.targetBranch ?? '?')}`;
    case 'hide': return `−${String(r.hidden ?? '?')} on ${String(r.branch ?? '?')}`;
    case 'settings-update': { try { return JSON.stringify(p.patch ?? {}); } catch { return ''; } }
    case 'settings-reset': return `keys: ${Array.isArray(p.keys) ? p.keys.join(',') : String(p.keys ?? 'all')}`;
    case 'quiesce': case 'resume': return typeof r.mode === 'string' ? `host ${r.mode}` : '';
    case 'nudge': return typeof r.agentStatus === 'string' ? `agent ${r.agentStatus}` : '';
    default: return '';
  }
}

export function OperatorLogList(props: {
  entries: OperatorLogEntryWire[];
  path?: string;
  loading: boolean;
  onRefresh(): void;
}) {
  const newestFirst = () => [...props.entries].reverse();
  return (
    <div class="border-t border-neutral-800 mt-2 pt-2">
      <div class="flex items-center gap-2 px-1 mb-1">
        <span class="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">operator log</span>
        <span class="text-neutral-600 text-[10px]">{props.entries.length || ''}</span>
        <button type="button" class="ml-auto px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-[10px]" onClick={props.onRefresh}>
          {props.loading ? '…' : 'refresh'}
        </button>
      </div>
      <Show when={props.path}><div class="px-1 text-[10px] text-neutral-600 truncate mb-1" title={props.path}>{props.path}</div></Show>
      <Show when={newestFirst().length > 0} fallback={<div class="px-1 text-neutral-600 italic text-[11px]">No operator actions recorded yet.</div>}>
        <div class="space-y-1 max-h-72 overflow-y-auto pr-1">
          <For each={newestFirst()}>{(e) => (
            <div class={`rounded px-1.5 py-1 border ${e.error ? 'border-rose-900/40 bg-rose-950/20' : 'border-neutral-800/60 bg-neutral-900/30'}`}
              title={(() => { try { return JSON.stringify(e, null, 1); } catch { return ''; } })()}>
              <div class="flex items-center gap-2 text-[10px]">
                <span class={`font-semibold ${kindColor(e.kind)}`}>{e.kind}</span>
                <Show when={e.agent}><span class="text-neutral-500">{e.agent}</span></Show>
                <span class="ml-auto text-neutral-600">{fmtAt(e.at)}</span>
              </div>
              <div class="text-[10px] text-neutral-400 truncate">
                {e.requester ? `${e.requester.name ?? e.requester.id ?? '?'} via ${e.requester.via}` : 'requester unknown'}
                {e.note ? ` — “${e.note}”` : ''}
              </div>
              <Show when={e.error} fallback={<Show when={summarize(e)}><div class="text-[10px] text-neutral-300 truncate">{summarize(e)}</div></Show>}>
                <div class="text-[10px] text-rose-300 truncate">✗ {e.error}</div>
              </Show>
            </div>
          )}</For>
        </div>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Awareness marks journal
// ---------------------------------------------------------------------------

const countsLine = (label: string, counts?: Record<string, number>): string => {
  if (!counts) return '';
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
  return parts.length > 0 ? `${label}: ${parts.join(', ')}` : '';
};

/**
 * The framework's awareness-marks journal: each surgery's batch and each
 * retract, with what is known about their requests. Cancel stops further
 * sends (never removes anything); retract queues removal of this bot's marks
 * (Discord requests, so it asks first); release sends a batch held at
 * startup. Receipts are shown as returned: history, not Discord's state.
 */
export function AwarenessList(props: {
  entries: AwarenessEntryWire[];
  loading: boolean;
  readOnly: boolean;
  result: { action?: string; target?: string; receipt?: Record<string, unknown>; error?: string } | null;
  onRefresh(): void;
  onAction(action: 'cancel' | 'retract' | 'release', target: string): void;
}) {
  const newestFirst = () => [...props.entries].sort((a, b) => (b.createdAt ?? b.at ?? 0) - (a.createdAt ?? a.at ?? 0));
  const [open, setOpen] = createSignal<string | null>(null);
  const act = (action: 'cancel' | 'retract' | 'release', target: string, detail?: { refs?: number; emoji?: string }): void => {
    if (action === 'retract' && !window.confirm(
      target === 'all'
        ? "Ask Discord to remove this bot's awareness reaction from every message any batch recorded (including batches not yet sent)? "
          + 'This sends one Discord request per message, whether or not a mark is there. It does not stop anything already on the wire.'
        : `Ask Discord to remove this bot's ${detail?.emoji ?? 'awareness'} reaction from this batch's ${detail?.refs ?? ''} recorded message(s)? `
          + 'This sends one Discord request per message, whether or not the mark landed.',
    )) return;
    if (action === 'release' && !window.confirm(
      `Carry out this held batch's ${detail?.refs ?? ''} recorded action(s)? Held actions can add or remove this bot's reactions; `
      + 'each is sent to Discord as recorded.',
    )) return;
    props.onAction(action, target);
  };
  const button = (label: string, onClick: () => void, tone = 'bg-neutral-800 hover:bg-neutral-700 text-neutral-300') => (
    <button type="button" class={`px-1.5 py-0.5 rounded text-[10px] ${tone}`} onClick={onClick}>{label}</button>
  );
  return (
    <div class="border-t border-neutral-800 mt-2 pt-2">
      <div class="flex items-center gap-2 px-1 mb-1">
        <span class="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">awareness marks</span>
        <span class="text-neutral-600 text-[10px]">{props.entries.length || ''}</span>
        <Show when={!props.readOnly && props.entries.some((e) => e.kind === 'batch')}>
          {button('retract all', () => act('retract', 'all'), 'bg-rose-950/60 hover:bg-rose-900/60 text-rose-200')}
        </Show>
        <button type="button" class="ml-auto px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-[10px]" onClick={props.onRefresh}>
          {props.loading ? '…' : 'refresh'}
        </button>
      </div>
      <div class="px-1 mb-1 text-[10px] text-neutral-600 leading-snug">
        Counts are the outcomes of requests recorded here, not what Discord shows now.
        <span class="text-neutral-500">cancel</span> stops sends not yet made (never removes);
        <span class="text-neutral-500">retract</span> requests removal of the bot's marks;
        <span class="text-neutral-500">release</span> carries out a held batch's recorded actions.
      </div>
      <Show when={props.result}>{(r) => (
        <div class={`px-1 mb-1 text-[10px] font-mono break-all ${r().error ? 'text-rose-300' : 'text-neutral-400'}`}>
          {r().action} {r().target}: {r().error ?? (() => { try { return JSON.stringify(r().receipt); } catch { return ''; } })()}
        </div>
      )}</Show>
      <Show when={newestFirst().length > 0} fallback={<div class="px-1 text-neutral-600 italic text-[11px]">No awareness marks recorded.</div>}>
        <div class="space-y-1 max-h-72 overflow-y-auto pr-1">
          <For each={newestFirst()}>{(e) => (
            <div class="rounded px-1.5 py-1 border border-neutral-800/60 bg-neutral-900/30">
              <div class="flex items-center gap-2 text-[10px]">
                <span class="font-semibold text-neutral-300">{e.kind === 'retract' ? 'retract' : `${e.scope ?? '?'} marks`}</span>
                <span class="text-neutral-500">{e.kind === 'retract' ? `of ${e.target}` : `${e.status}${e.cancelled ? ', cancelled' : ''}`}</span>
                <span class="ml-auto text-neutral-600">{(e.createdAt ?? e.at) ? fmtAt(new Date((e.createdAt ?? e.at)!).toISOString()) : ''}</span>
              </div>
              <div class="text-[10px] text-neutral-400 break-words">
                {e.kind === 'batch'
                  ? `${e.agentName ?? ''} → ${e.targetBranch ?? ''} · ${e.refs ?? 0} message(s)${e.unmarked ? ` · ${e.unmarked} unmarked` : ''}`
                  : `${e.by ? `by ${e.by}` : ''}${e.cancelled ? ' · cancelled' : ''}`}
              </div>
              <div class="text-[10px] text-neutral-500 break-words">
                {[countsLine('add requests', e.adds), countsLine('removal requests', e.removals)].filter(Boolean).join(' · ')}
              </div>
              <Show when={e.unresolvedAttempts}>
                <div class="text-[10px] text-amber-300/90 break-words">
                  {e.unresolvedAttempts} request(s) without an answer: each may have landed, or may still land.
                </div>
              </Show>
              <Show when={e.held}><div class="text-[10px] text-amber-300/90 break-words">held: {e.held!.reason}</div></Show>
              <Show when={e.legacy}>
                <div class="text-[10px] text-neutral-500 break-words">
                  earlier ledger: {e.legacy!.lastAddConfirmed} add(s) confirmed, {e.legacy!.outcomesUnrecorded} attempt outcome(s) unrecorded (they may have landed)
                </div>
              </Show>
              <Show when={open() === e.id}>
                <pre class="mt-1 p-1 text-[10px] text-neutral-400 bg-neutral-950 border border-neutral-800 rounded whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                  {(() => { try { return JSON.stringify(e, null, 2); } catch { return ''; } })()}
                </pre>
              </Show>
              <div class="flex gap-1 mt-0.5">
                {button(open() === e.id ? 'hide details' : 'details', () => setOpen(open() === e.id ? null : e.id))}
                <Show when={!props.readOnly}>
                  <Show when={e.kind === 'retract' ? !e.cancelled : e.status !== 'discarded' && !e.cancelled}>
                    {button('cancel', () => act('cancel', e.id))}
                  </Show>
                  <Show when={e.kind === 'batch' && e.status !== 'discarded'}>
                    {button('retract', () => act('retract', e.id, { refs: e.refs, emoji: e.emoji }), 'bg-rose-950/60 hover:bg-rose-900/60 text-rose-200')}
                  </Show>
                  <Show when={e.kind === 'batch' && e.status === 'held'}>
                    {button('release', () => act('release', e.id, { refs: e.held?.releaseActions }), 'bg-amber-900/50 hover:bg-amber-900/80 text-amber-100')}
                  </Show>
                </Show>
              </div>
            </div>
          )}</For>
        </div>
      </Show>
    </div>
  );
}
