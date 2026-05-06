/**
 * MCPL admin panel — read/write view of mcpl-servers.json. Mirrors the
 * `/mcp list|add|remove|env` slash commands but with structured controls.
 *
 * Mutations are file-only — the host needs to restart for them to take
 * effect. The panel makes that explicit so operators don't expect live
 * reconnects.
 */

import { createSignal, For, Show } from 'solid-js';

export interface McplServerRow {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  toolPrefix?: string;
  reconnect?: boolean;
  enabledFeatureSets?: string[];
  disabledFeatureSets?: string[];
}

export function McplPanel(props: {
  loaded: boolean;
  configPath: string;
  servers: McplServerRow[];
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
        <button
          type="button"
          class="px-2 py-0.5 text-[10px] bg-cyan-900/40 hover:bg-cyan-900/60 text-cyan-200 rounded font-mono"
          onClick={() => setShowAdd(s => !s)}
        >
          {showAdd() ? 'cancel add' : '+ add'}
        </button>
      </div>

      <Show when={!props.loaded}>
        <div class="text-neutral-600 italic">Loading…</div>
      </Show>

      <Show when={props.loaded}>
        <div class="text-[10px] text-neutral-600 italic mb-2 break-all" title={props.configPath}>
          {props.configPath}
        </div>

        <Show when={showAdd()}>
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
              onRemove={() => props.onRemove(server.id)}
              onSetEnv={(env) => props.onSetEnv(server.id, env)}
            />
          )}</For>
        </div>

        <Show when={props.servers.length > 0}>
          <div class="mt-3 text-[10px] text-amber-300/80 italic">
            Changes are written to disk; restart the host process to apply.
          </div>
        </Show>
      </Show>
    </div>
  );
}

function ServerCard(props: {
  server: McplServerRow;
  onRemove(): void;
  onSetEnv(env: Record<string, string>): void;
}) {
  const [editEnv, setEditEnv] = createSignal(false);
  const [confirmDel, setConfirmDel] = createSignal(false);
  const cmdLine = (): string => [props.server.command, ...(props.server.args ?? [])].join(' ');
  const envEntries = (): Array<[string, string]> => Object.entries(props.server.env ?? {});

  return (
    <div class="border border-neutral-800 rounded px-2 py-1.5 bg-neutral-950">
      <div class="flex items-baseline gap-2 mb-1">
        <span class="font-mono text-cyan-300 truncate">{props.server.id}</span>
        <Show when={props.server.toolPrefix}>
          <span class="text-[10px] text-neutral-600">prefix={props.server.toolPrefix}</span>
        </Show>
        <Show when={props.server.reconnect}>
          <span class="text-[10px] text-emerald-400">↻ reconnect</span>
        </Show>
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
      </div>
      <div class="font-mono text-neutral-300 text-[11px] break-all leading-tight">
        {cmdLine()}
      </div>
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
