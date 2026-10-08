/**
 * MCPL panel — two views of one scope's MCPL world:
 *
 *   live      what the scoped process actually LOADED (recipe opt-in +
 *             agent overlay), with connection status and tool counts. This
 *             is the per-scope truth: a conductor with zero MCPLs and a
 *             clerk with five share the same registry file.
 *   registry  the shared mcpl-servers.json (editable). Mutations are
 *             file-only — a restart applies them — and happen on the HOST
 *             scope: the file is one cwd-shared registry for the whole
 *             fleet, so the panel goes read-only on child scopes rather
 *             than pretending a "child-local" edit exists.
 *
 * Under the live list, the scoped process's tool classes: every tool it
 * offers with its effective MCPL class (RFC-008) and the source that decided
 * it — the same data as `/tools` and `GET /debug/tool-classes`.
 */

import { createSignal, For, Show } from 'solid-js';

export interface McplServerRow {
  id: string;
  /** What the entry connects to, as the host resolved it by the framework's
   *  binding rules: its command line on stdio, its url on a network transport. */
  target: string;
  family?: 'legacy' | 'modern';
  transport?: 'stdio' | 'websocket' | 'http';
  /** Why the framework refuses the entry (it stops the host's startup). */
  problems?: string[];
  env?: Record<string, string>;
  toolPrefix?: string;
  reconnect?: boolean;
  enabledFeatureSets?: string[];
  disabledFeatureSets?: string[];
}

/** A server the scoped process has actually loaded, with live status. */
export interface McplLiveRow {
  id: string;
  connected: boolean;
  toolCount: number;
  toolPrefix?: string;
  target?: string;
  family?: 'legacy' | 'modern';
  protocolVersion?: string;
  transport?: string;
}

/** One tool's effective MCPL class (RFC-008) and where it came from. */
export interface ToolClassRow {
  tool: string;
  /** Empty for an unclassed tool. */
  class: string[];
  source: 'override' | 'host' | 'server' | 'none';
  /** The providing MCPL server, for MCPL tools. */
  serverId?: string;
}

const SOURCE_LABEL: Record<ToolClassRow['source'], string> = {
  override: 'operator override',
  host: 'host table',
  server: 'server _meta',
  none: 'unclassed',
};

const SOURCE_TITLE: Record<ToolClassRow['source'], string> = {
  override: "the recipe's toolClassOverrides",
  host: "this host's (or the framework's) table of its own tools",
  server: 'declared by the MCPL server (_meta["mcpl/class"])',
  none: 'no class: handled as the most restrictive (observers never see its arguments)',
};

const SOURCE_TONE: Record<ToolClassRow['source'], string> = {
  override: 'text-cyan-300',
  host: 'text-neutral-400',
  server: 'text-emerald-300',
  none: 'text-amber-300',
};

export function McplPanel(props: {
  loaded: boolean;
  configPath: string;
  servers: McplServerRow[];
  /** Servers the scoped process actually loaded, with connection status.
   *  Empty array is meaningful ("this process runs no MCPLs"); undefined
   *  means an older host that doesn't report it. */
  live?: McplLiveRow[];
  /** Every tool the scoped process offers, with its effective class.
   *  Undefined when the host/framework doesn't report classes. */
  toolClasses?: ToolClassRow[];
  /** True on fleet-child scopes: registry edits stay on the host scope. */
  readOnly?: boolean;
  onRefresh(): void;
  onAdd(input: { id: string; command: string; args?: string[]; env?: Record<string, string>; toolPrefix?: string }): void;
  onRemove(id: string): void;
  onSetEnv(id: string, env: Record<string, string>): void;
}) {
  const [showAdd, setShowAdd] = createSignal(false);

  return (
    <div class="h-full overflow-y-auto px-3 py-2 text-xs">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold">
          MCPL servers
        </span>
        <span class="text-neutral-600 text-[10px]">{props.servers.length}</span>
        <button
          type="button"
          class="ml-auto px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
          onClick={() => props.onRefresh()}
        >
          refresh
        </button>
        <Show when={!props.readOnly}>
          <button
            type="button"
            class="px-2 py-0.5 text-[10px] bg-cyan-900/40 hover:bg-cyan-900/60 text-cyan-200 rounded font-mono"
            onClick={() => setShowAdd(s => !s)}
          >
            {showAdd() ? 'cancel add' : '+ add'}
          </button>
        </Show>
      </div>

      <Show when={!props.loaded}>
        <div class="text-neutral-600 italic">Loading…</div>
      </Show>

      <Show when={props.loaded}>
        {/* ---- live: what this process actually runs ---- */}
        <Show when={props.live !== undefined}>
          <div class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold mb-1">
            loaded by this process
          </div>
          <Show when={props.live!.length === 0}>
            <div class="text-neutral-600 italic mb-2">
              No MCPL servers loaded — the recipe opts into none.
            </div>
          </Show>
          <div class="space-y-1 mb-3">
            <For each={props.live}>{(s) => (
              <div class="border border-neutral-800 rounded px-2 py-1 bg-neutral-950 flex items-baseline gap-2">
                <span class={`inline-block w-2 h-2 rounded-full self-center shrink-0 ${s.connected ? 'bg-emerald-500' : 'bg-rose-500'}`}
                  title={s.connected ? 'connected' : 'disconnected'} />
                <span class="font-mono text-cyan-300 truncate">{s.id}</span>
                <span class="text-[10px] text-neutral-500 shrink-0">{s.toolCount} tools</span>
                <Show when={s.family}>
                  <span class="text-[10px] text-neutral-500 shrink-0"
                    title={s.family === 'modern' ? 'modern MCP (no MCPL surface)' : 'MCP + MCPL'}>
                    {s.family}{s.protocolVersion ? `@${s.protocolVersion}` : ''}{s.transport ? `/${s.transport}` : ''}
                  </span>
                </Show>
                <Show when={s.toolPrefix}>
                  <span class="text-[10px] text-neutral-600 shrink-0">prefix={s.toolPrefix}</span>
                </Show>
                <Show when={s.target}>
                  <span class="text-[10px] font-mono text-neutral-600 truncate ml-auto" title={s.target}>
                    {s.target}
                  </span>
                </Show>
              </div>
            )}</For>
          </div>
          <Show when={props.toolClasses !== undefined}>
            <ToolClasses rows={props.toolClasses!} />
          </Show>
          <div class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold mb-1">
            shared registry
          </div>
        </Show>

        <div class="text-[10px] text-neutral-600 italic mb-2 break-all" title={props.configPath}>
          {props.configPath}
        </div>

        <Show when={props.readOnly}>
          <div class="text-[10px] text-neutral-500 italic mb-2">
            The registry file is shared fleet-wide — edit it from the host
            scope. Which entries this child loads is its recipe's opt-in.
          </div>
        </Show>

        <Show when={showAdd() && !props.readOnly}>
          <AddServerForm
            onSubmit={(input) => {
              props.onAdd(input);
              setShowAdd(false);
            }}
            onCancel={() => setShowAdd(false)}
          />
        </Show>

        <Show when={props.loaded && props.servers.length === 0 && !showAdd()}>
          <div class="text-neutral-600 italic">No MCPL servers configured.</div>
        </Show>

        <div class="space-y-2">
          <For each={props.servers}>{(server) => (
            <ServerCard
              server={server}
              readOnly={props.readOnly ?? false}
              onRemove={() => props.onRemove(server.id)}
              onSetEnv={(env) => props.onSetEnv(server.id, env)}
            />
          )}</For>
        </div>

        <Show when={props.servers.length > 0 && !props.readOnly}>
          <div class="mt-3 text-[10px] text-amber-300/80 italic">
            Changes are written to disk; restart the host process to apply.
          </div>
        </Show>
      </Show>
    </div>
  );
}

/** Per-source counts, always visible; the per-tool list on demand. */
function ToolClasses(props: { rows: ToolClassRow[] }) {
  const [open, setOpen] = createSignal(false);
  const counts = (): Array<[ToolClassRow['source'], number]> =>
    (['override', 'host', 'server', 'none'] as const)
      .map((source): [ToolClassRow['source'], number] => [source, props.rows.filter(r => r.source === source).length])
      .filter(([, n]) => n > 0);
  return (
    <div class="mb-3">
      <div class="flex items-baseline gap-2 mb-1">
        <span class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold">
          tool classes
        </span>
        <span class="text-neutral-600 text-[10px]">{props.rows.length}</span>
        <Show when={props.rows.length > 0}>
          <button
            type="button"
            class="ml-auto px-1 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
            onClick={() => setOpen(o => !o)}
          >
            {open() ? 'hide' : 'show'}
          </button>
        </Show>
      </div>
      <div class="flex flex-wrap gap-x-2 text-[10px]">
        <For each={counts()}>{([source, n]) => (
          <span class={SOURCE_TONE[source]} title={SOURCE_TITLE[source]}>
            {n} {SOURCE_LABEL[source]}
          </span>
        )}</For>
      </div>
      <Show when={open()}>
        <div class="mt-1 border border-neutral-800 rounded bg-neutral-950 divide-y divide-neutral-900">
          <For each={props.rows}>{(r) => (
            // Wraps instead of squeezing: when class + source don't fit
            // beside the name they drop to a second line, so the tool name
            // always keeps the row's width.
            <div class="px-2 py-0.5 flex flex-wrap items-baseline gap-x-2">
              <span class="font-mono text-neutral-200 truncate min-w-0 max-w-full" title={r.tool}>{r.tool}</span>
              <span class="ml-auto min-w-0 flex flex-wrap justify-end items-baseline gap-x-2 text-[10px]">
                <span class="font-mono text-neutral-400 break-all">
                  {r.class.length > 0 ? r.class.join(',') : '—'}
                </span>
                <span class={`break-all ${SOURCE_TONE[r.source]}`} title={SOURCE_TITLE[r.source]}>
                  {SOURCE_LABEL[r.source]}{r.serverId ? ` · ${r.serverId}` : ''}
                </span>
              </span>
            </div>
          )}</For>
        </div>
      </Show>
    </div>
  );
}

function ServerCard(props: {
  server: McplServerRow;
  readOnly: boolean;
  onRemove(): void;
  onSetEnv(env: Record<string, string>): void;
}) {
  const [editEnv, setEditEnv] = createSignal(false);
  const [confirmDel, setConfirmDel] = createSignal(false);
  const envEntries = (): Array<[string, string]> => Object.entries(props.server.env ?? {});

  return (
    <div class="border border-neutral-800 rounded px-2 py-1.5 bg-neutral-950">
      <div class="flex items-baseline gap-2 mb-1">
        <span class="font-mono text-cyan-300 truncate">{props.server.id}</span>
        <Show when={props.server.family}>
          <span class="text-[10px] text-neutral-500 shrink-0"
            title={props.server.family === 'modern' ? 'modern MCP (no MCPL surface)' : 'MCP + MCPL'}>
            {props.server.family}/{props.server.transport}
          </span>
        </Show>
        <Show when={props.server.toolPrefix}>
          <span class="text-[10px] text-neutral-600">prefix={props.server.toolPrefix}</span>
        </Show>
        <Show when={props.server.reconnect}>
          <span class="text-[10px] text-emerald-400">↻ reconnect</span>
        </Show>
        <Show when={!props.readOnly}>
        <button
          type="button"
          class="ml-auto text-[10px] px-1 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
          onClick={() => setEditEnv(s => !s)}
        >
          {editEnv() ? 'close env' : 'env'}
        </button>
        <Show when={!confirmDel()} fallback={
          <span class="flex gap-1">
            <button
              type="button"
              class="text-[10px] px-1 py-0.5 bg-rose-900/60 hover:bg-rose-900 text-rose-100 rounded font-mono"
              onClick={() => { props.onRemove(); setConfirmDel(false); }}
            >
              confirm
            </button>
            <button
              type="button"
              class="text-[10px] px-1 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
              onClick={() => setConfirmDel(false)}
            >
              ✕
            </button>
          </span>
        }>
          <button
            type="button"
            class="text-[10px] px-1 py-0.5 bg-rose-900/40 hover:bg-rose-900/60 text-rose-200 rounded font-mono"
            onClick={() => setConfirmDel(true)}
          >
            remove
          </button>
        </Show>
        </Show>
      </div>
      <div class="font-mono text-neutral-300 text-[11px] break-all leading-tight">
        {props.server.target}
      </div>
      <Show when={props.server.problems}>
        <div class="mt-1 text-[10px] text-rose-300 break-all leading-tight">
          refused at startup: {props.server.problems!.join('; ')}
        </div>
      </Show>
      <Show when={envEntries().length > 0 && !editEnv()}>
        <div class="mt-1 flex flex-wrap gap-1">
          <For each={envEntries()}>{([k]) => (
            <span class="text-[10px] font-mono text-neutral-500 bg-neutral-900 px-1 rounded" title="(value hidden — open env to view)">
              {k}
            </span>
          )}</For>
        </div>
      </Show>
      <Show when={editEnv()}>
        <EnvEditor
          initial={props.server.env ?? {}}
          onSave={(env) => { props.onSetEnv(env); setEditEnv(false); }}
          onCancel={() => setEditEnv(false)}
        />
      </Show>
    </div>
  );
}

function AddServerForm(props: {
  onSubmit(input: { id: string; command: string; args?: string[]; env?: Record<string, string>; toolPrefix?: string }): void;
  onCancel(): void;
}) {
  const [id, setId] = createSignal('');
  const [command, setCommand] = createSignal('');
  const [argsRaw, setArgsRaw] = createSignal('');
  const [envRaw, setEnvRaw] = createSignal('');
  const [toolPrefix, setToolPrefix] = createSignal('');

  const submit = (): void => {
    if (!id().trim() || !command().trim()) return;
    const args = argsRaw().trim() ? splitArgs(argsRaw().trim()) : undefined;
    const env = parseEnvBlock(envRaw());
    props.onSubmit({
      id: id().trim(),
      command: command().trim(),
      ...(args && args.length > 0 ? { args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(toolPrefix().trim() ? { toolPrefix: toolPrefix().trim() } : {}),
    });
  };

  return (
    <div class="border border-cyan-800 rounded px-2 py-2 bg-cyan-950/20 mb-2 space-y-1.5">
      <div class="text-[10px] uppercase tracking-wider text-cyan-300 font-semibold mb-1">Add server</div>
      <Field label="id" value={id()} onInput={setId} placeholder="my-server" />
      <Field label="command" value={command()} onInput={setCommand} placeholder="bun" />
      <Field label="args" value={argsRaw()} onInput={setArgsRaw} placeholder="run server.ts" />
      <Field label="toolPrefix" value={toolPrefix()} onInput={setToolPrefix} placeholder="(optional)" />
      <div>
        <div class="text-[10px] text-neutral-500 mb-0.5">env (KEY=VALUE per line)</div>
        <textarea
          class="w-full bg-neutral-900 border border-neutral-800 rounded px-1.5 py-1 text-[11px] font-mono text-neutral-100 resize-y focus:outline-none focus:ring-1 focus:ring-cyan-700"
          rows="3"
          value={envRaw()}
          onInput={(e) => setEnvRaw(e.currentTarget.value)}
          placeholder="API_KEY=..."
        />
      </div>
      <div class="flex gap-1 pt-1">
        <button
          type="button"
          class="px-2 py-0.5 text-[10px] bg-cyan-900/60 hover:bg-cyan-800 text-cyan-100 rounded font-mono"
          onClick={submit}
        >
          save
        </button>
        <button
          type="button"
          class="px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
          onClick={() => props.onCancel()}
        >
          cancel
        </button>
      </div>
    </div>
  );
}

function EnvEditor(props: {
  initial: Record<string, string>;
  onSave(env: Record<string, string>): void;
  onCancel(): void;
}) {
  const initialText = (): string => Object.entries(props.initial)
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const [text, setText] = createSignal(initialText());
  return (
    <div class="mt-2 border border-neutral-800 rounded p-1.5 bg-neutral-900/40">
      <div class="text-[10px] text-neutral-500 mb-1">env (KEY=VALUE per line; empty clears)</div>
      <textarea
        class="w-full bg-neutral-950 border border-neutral-800 rounded px-1.5 py-1 text-[11px] font-mono text-neutral-100 resize-y focus:outline-none focus:ring-1 focus:ring-neutral-600"
        rows="4"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div class="flex gap-1 mt-1">
        <button
          type="button"
          class="px-2 py-0.5 text-[10px] bg-cyan-900/60 hover:bg-cyan-800 text-cyan-100 rounded font-mono"
          onClick={() => props.onSave(parseEnvBlock(text()) ?? {})}
        >
          save
        </button>
        <button
          type="button"
          class="px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
          onClick={() => props.onCancel()}
        >
          cancel
        </button>
      </div>
    </div>
  );
}

function Field(props: { label: string; value: string; onInput: (v: string) => void; placeholder?: string }) {
  return (
    <div class="flex items-baseline gap-2">
      <label class="w-20 text-[10px] text-neutral-500 shrink-0">{props.label}</label>
      <input
        type="text"
        class="flex-1 bg-neutral-900 border border-neutral-800 rounded px-1.5 py-0.5 text-[11px] font-mono text-neutral-100 focus:outline-none focus:ring-1 focus:ring-cyan-700"
        value={props.value}
        placeholder={props.placeholder}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
    </div>
  );
}

/** Naive whitespace split — sufficient for the args field where shell-quoted
 *  values with spaces are uncommon. Operators editing complex commands can
 *  hand-edit mcpl-servers.json directly. */
function splitArgs(raw: string): string[] {
  return raw.split(/\s+/).filter(s => s.length > 0);
}

/** Parse a KEY=VALUE-per-line block into an env object. Returns null if the
 *  block is empty (so the caller can omit the env field entirely). */
function parseEnvBlock(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    const v = trimmed.slice(eqIdx + 1).trim();
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}
