/**
 * Files panel — workspace-aware browser for the parent process's mounts.
 *
 * Lists mounts, expands one at a time on click, builds a hierarchical tree
 * from the flat workspace `ls -r` output, and lets the operator click a
 * file to view its content in a centered modal.
 *
 * Reads only — write/edit/delete aren't surfaced here. Operators with that
 * intent should be on the host shell anyway.
 */

import { createSignal, For, Show } from 'solid-js';
import { ScopePicker } from './Lessons';

export interface Mount {
  name: string;
  path: string;
  mode: string;
}

export interface FlatEntry {
  path: string;
  size: number;
}

export interface FileViewer {
  path: string;
  totalLines: number;
  fromLine: number;
  toLine: number;
  content: string;
  truncated: boolean;
}

export function FilesPanel(props: {
  loaded: boolean;
  moduleLoaded: boolean;
  mounts: Mount[];
  /** Currently-loaded tree, keyed by mount name. Populated lazily on
   *  expand-click — the parent component maintains the cache. */
  treesByMount: Map<string, FlatEntry[]>;
  /** Mounts that have been expanded at least once. */
  expandedMounts: Set<string>;
  /** Currently-selected scope ('local' or fleet child name). */
  scope: string;
  /** Selectable scopes — always includes 'local', plus every fleet child. */
  scopes: Array<{ id: string; label: string }>;
  onScopeChange(scope: string): void;
  onRefreshMounts(): void;
  onExpandMount(name: string): void;
  onCollapseMount(name: string): void;
  onOpenFile(path: string): void;
}) {
  return (
    <div class="h-full overflow-y-auto px-3 py-2 text-xs">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold">
          workspace
        </span>
        <span class="text-neutral-600 text-[10px]">{props.mounts.length} mounts</span>
        <button
          type="button"
          class="ml-auto px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
          onClick={() => props.onRefreshMounts()}
        >
          refresh
        </button>
      </div>
      <ScopePicker scope={props.scope} scopes={props.scopes} onChange={props.onScopeChange} />

      <Show when={!props.loaded}>
        <div class="text-neutral-600 italic">Loading…</div>
      </Show>

      <Show when={props.loaded && !props.moduleLoaded}>
        <div class="text-neutral-600 italic">
          WorkspaceModule not loaded in this recipe.
        </div>
      </Show>

      <Show when={props.loaded && props.moduleLoaded && props.mounts.length === 0}>
        <div class="text-neutral-600 italic">No mounts configured.</div>
      </Show>

      <div class="space-y-1">
        <For each={props.mounts}>{(mount) => (
          <MountSection
            mount={mount}
            expanded={props.expandedMounts.has(mount.name)}
            entries={props.treesByMount.get(mount.name) ?? []}
            onToggle={() => {
              if (props.expandedMounts.has(mount.name)) props.onCollapseMount(mount.name);
              else props.onExpandMount(mount.name);
            }}
            onOpenFile={props.onOpenFile}
          />
        )}</For>
      </div>
    </div>
  );
}

function MountSection(props: {
  mount: Mount;
  expanded: boolean;
  entries: FlatEntry[];
  onToggle(): void;
  onOpenFile(path: string): void;
}) {
  const tree = (): TreeNode => buildTree(props.entries);
  return (
    <div class="border border-neutral-800 rounded">
      <button
        type="button"
        class="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-neutral-900/50"
        onClick={() => props.onToggle()}
      >
        <span class="text-neutral-500">{props.expanded ? '▾' : '▸'}</span>
        <span class="font-mono text-cyan-300 truncate">{props.mount.name}</span>
        <span class="text-[10px] text-neutral-600">{props.mount.mode}</span>
        <span class="ml-auto text-[10px] text-neutral-600 truncate" title={props.mount.path}>
          {props.mount.path}
        </span>
      </button>
      <Show when={props.expanded}>
        <div class="px-2 py-1 border-t border-neutral-800 bg-neutral-950/40">
          <Show when={props.entries.length === 0}>
            <div class="text-[11px] text-neutral-600 italic">empty</div>
          </Show>
          <For each={tree().children}>{(child) => (
            <TreeRow node={child} depth={0} mountName={props.mount.name} onOpenFile={props.onOpenFile} />
          )}</For>
        </div>
      </Show>
    </div>
  );
}

interface TreeNode {
  /** Empty string for the synthetic root. */
  name: string;
  /** Full path rooted at the mount (so the row can pass it to onOpenFile). */
  fullPath: string;
  isDir: boolean;
  size?: number;
  children: TreeNode[];
}

function buildTree(entries: FlatEntry[]): TreeNode {
  const root: TreeNode = { name: '', fullPath: '', isDir: true, children: [] };
  for (const entry of entries) {
    const parts = entry.path.split('/').filter(p => p.length > 0);
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      let next = cursor.children.find(c => c.name === part);
      if (!next) {
        next = {
          name: part,
          fullPath: parts.slice(0, i + 1).join('/'),
          isDir: !isLast,
          ...(isLast ? { size: entry.size } : {}),
          children: [],
        };
        cursor.children.push(next);
      }
      cursor = next;
    }
  }
  // Sort children: dirs first, then files, alpha within each.
  const sortNode = (node: TreeNode): void => {
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) sortNode(c);
  };
  sortNode(root);
  return root;
}

function TreeRow(props: { node: TreeNode; depth: number; mountName: string; onOpenFile(path: string): void }) {
  const [expanded, setExpanded] = createSignal(props.depth < 1);
  const indent = (): string => `${0.25 + props.depth * 0.75}rem`;
  const fullMountPath = (): string => `${props.mountName}/${props.node.fullPath}`;
  return (
    <div>
      <Show when={props.node.isDir} fallback={
        <button
          type="button"
          class="w-full flex items-center gap-2 py-0.5 hover:bg-neutral-900/60 text-left rounded"
          style={{ 'padding-left': indent() }}
          onClick={() => props.onOpenFile(fullMountPath())}
          title={fullMountPath()}
        >
          <span class="text-neutral-500 w-3 inline-block" />
          <span class="font-mono text-neutral-300 truncate">{props.node.name}</span>
          <Show when={typeof props.node.size === 'number'}>
            <span class="ml-auto text-[10px] text-neutral-600">{fmtSize(props.node.size!)}</span>
          </Show>
        </button>
      }>
        <button
          type="button"
          class="w-full flex items-center gap-2 py-0.5 hover:bg-neutral-900/60 text-left rounded"
          style={{ 'padding-left': indent() }}
          onClick={() => setExpanded(s => !s)}
        >
          <span class="text-neutral-500 w-3 inline-block">{expanded() ? '▾' : '▸'}</span>
          <span class="font-mono text-cyan-200 truncate">{props.node.name}/</span>
        </button>
        <Show when={expanded()}>
          <For each={props.node.children}>{(child) => (
            <TreeRow node={child} depth={props.depth + 1} mountName={props.mountName} onOpenFile={props.onOpenFile} />
          )}</For>
        </Show>
      </Show>
    </div>
  );
}

export function FileViewerModal(props: {
  file: FileViewer | null;
  loading: boolean;
  onClose(): void;
}) {
  return (
    <Show when={props.loading || props.file}>
      <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => props.onClose()}>
        <div class="bg-neutral-950 border border-neutral-700 rounded-lg shadow-2xl w-[80vw] h-[80vh] m-4 flex flex-col" onClick={(e) => e.stopPropagation()}>
          <div class="border-b border-neutral-800 px-3 py-2 flex items-center gap-2">
            <span class="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">file</span>
            <span class="font-mono text-sm text-neutral-200 truncate">
              {props.file?.path ?? 'loading…'}
            </span>
            <Show when={props.file}>
              <span class="text-[10px] text-neutral-600">
                lines {props.file!.fromLine}–{props.file!.toLine} of {props.file!.totalLines}
                <Show when={props.file!.truncated}>
                  <span class="ml-2 text-amber-400">truncated</span>
                </Show>
              </span>
            </Show>
            <button
              type="button"
              class="ml-auto px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs"
              onClick={() => props.onClose()}
            >
              close
            </button>
          </div>
          <div class="flex-1 overflow-auto px-3 py-2 font-mono text-[11px] whitespace-pre text-neutral-200 bg-neutral-950">
            <Show when={props.loading}>
              <div class="text-neutral-600 italic">Loading…</div>
            </Show>
            <Show when={props.file && !props.loading}>
              {props.file!.content}
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
