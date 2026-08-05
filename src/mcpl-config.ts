/**
 * File-driven MCPL server configuration.
 *
 * Reads/writes `mcpl-servers.json` (CC `.mcp.json` shape), keyed by server ID.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { REFUSAL_REACTION_BASELINE } from '@animalabs/agent-framework';

/** Default config file path, resolved from cwd. */
export const DEFAULT_CONFIG_PATH = resolve(process.cwd(), 'mcpl-servers.json');

/**
 * Serializable subset of McplServerConfig (everything except callbacks and scopes).
 */
export interface ServerFileEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  toolPrefix?: string;
  reconnect?: boolean;
  reconnectIntervalMs?: number;
  reconnectMaxIntervalMs?: number;
  enabledFeatureSets?: string[];
  disabledFeatureSets?: string[];
  enabledTools?: string[];
  disabledTools?: string[];
  /** @deprecated One-time migration input for legacy installations. */
  channelSubscription?: 'auto' | 'manual' | string[];
  /**
   * Name of a network access grant (an archipelago audience, e.g.
   * "eidoverse"). Purely declarative here: at load/deploy time the host
   * attaches a credential provider that fetches something fresh on every
   * dial via the identity module. The agent (and this file) never holds a
   * credential — `access` is a name, not a secret.
   */
  access?: string;
}

export interface McplServersFile {
  mcplServers: Record<string, ServerFileEntry>;
}

/** A loaded server config — serializable fields plus the id from the key. */
export type LoadedServerConfig = ServerFileEntry & { id: string };

/**
 * Load MCPL server configs from a JSON file.
 * Returns empty array if the file doesn't exist.
 * Resolves relative paths in `args` relative to the config file's directory.
 */
export function loadMcplServers(configPath: string): LoadedServerConfig[] {
  if (!existsSync(configPath)) return [];

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as McplServersFile;
  if (!parsed.mcplServers || typeof parsed.mcplServers !== 'object') return [];

  const configDir = dirname(resolve(configPath));
  const servers: LoadedServerConfig[] = [];

  for (const [id, entry] of Object.entries(parsed.mcplServers)) {
    const args = entry.args?.map(arg => {
      // Resolve relative paths (starting with ./ or ../) relative to config dir
      if (arg.startsWith('./') || arg.startsWith('../')) {
        return resolve(configDir, arg);
      }
      return arg;
    });

    servers.push({
      id,
      command: entry.command,
      args,
      env: entry.env,
      toolPrefix: entry.toolPrefix,
      reconnect: entry.reconnect,
      reconnectIntervalMs: entry.reconnectIntervalMs,
      reconnectMaxIntervalMs: entry.reconnectMaxIntervalMs,
      enabledFeatureSets: entry.enabledFeatureSets,
      disabledFeatureSets: entry.disabledFeatureSets,
      enabledTools: entry.enabledTools,
      disabledTools: entry.disabledTools,
      channelSubscription: entry.channelSubscription,
    });
  }

  return servers;
}

// ---------------------------------------------------------------------------
// Agent overlay — servers the agent deployed/unloaded for itself at runtime
// ---------------------------------------------------------------------------

/** Default agent-owned overlay path, resolved from cwd (per-agent deploy dir). */
export const DEFAULT_AGENT_OVERLAY_PATH = resolve(process.cwd(), 'mcpl-servers.agent.json');

/**
 * An overlay entry is either a full server definition (agent-deployed, loads
 * unconditionally — no recipe opt-in needed) or a tombstone `{disabled: true}`
 * that suppresses a recipe/file server the agent unloaded.
 *
 * Unlike `ServerFileEntry`, `command` is optional here: an entry has EITHER
 * a `command` (stdio) or a `url` (WebSocket), and tombstones have neither.
 */
export interface AgentOverlayEntry extends Partial<ServerFileEntry> {
  /** WebSocket URL (WebSocket transport). Mutually exclusive with command. */
  url?: string;
  transport?: 'stdio' | 'websocket';
  /** Bearer token for WebSocket auth. */
  token?: string;
  /** Tombstone: suppress a recipe/file server the agent unloaded. */
  disabled?: boolean;
}

export interface AgentOverlayFile {
  mcplServers: Record<string, AgentOverlayEntry>;
}

/** Read the agent overlay file. Returns empty object if it doesn't exist. */
export function readAgentOverlay(overlayPath: string): Record<string, AgentOverlayEntry> {
  if (!existsSync(overlayPath)) return {};
  const raw = readFileSync(overlayPath, 'utf-8');
  const parsed = JSON.parse(raw) as AgentOverlayFile;
  return parsed.mcplServers ?? {};
}

/** Write the agent overlay file. */
export function saveAgentOverlay(
  overlayPath: string,
  servers: Record<string, AgentOverlayEntry>,
): void {
  const data: AgentOverlayFile = { mcplServers: servers };
  writeFileSync(overlayPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Capabilities an agent-deployed server is never granted by default: the
 * consequential surfaces — context hooks (observation of and injection into
 * the agent's own inference), server-initiated inference, and inference
 * lifecycle. Bare parents on purpose: the config mask's subtree matching
 * denies everything beneath them, present and future (afterInference, undo,
 * state land under these the day the vocabulary grows them). A world/chat
 * server needs none of this — channels + tools is the whole job. An operator
 * who wants a self-deployed server to hold one of these moves the server
 * into the recipe, where `enabledCapabilities` is theirs to write.
 */
export const AGENT_DEPLOY_DENIED_CAPABILITIES: readonly string[] = [
  'contextHooks',
  'inferenceRequest',
  'inferenceLifecycle',
];

/** The allow/deny list fields where an EMPTY array carries no intent (see
 *  resolveOverlayEntry — OpenAI strict function calling forces every schema
 *  property, so agent tool calls arrive with `[]` meaning "unspecified"). */
const OVERLAY_LIST_FIELDS = [
  'enabledFeatureSets',
  'disabledFeatureSets',
  'enabledTools',
  'disabledTools',
] as const;

/**
 * Resolve an overlay entry into a server config object (id + fields, relative
 * `./`/`../` args resolved against the overlay file's directory). Returns
 * null for tombstones and entries with neither command nor url.
 *
 * The overlay is the AGENT's file, so resolution is also where host policy
 * for self-deployed servers lives (applied at boot AND at deploy — existing
 * files heal without a re-deploy):
 *
 *  - Empty allow/deny lists are treated as absent. OpenAI-style strict
 *    function calling forces every schema property, so GPT-family residents
 *    calling mcpl_deploy emit `[]` where they meant "unspecified" — and for
 *    the allowlists PRESENT-empty is deny-all under the §5.3 pin (Mica's
 *    silently eventless eidoverse, 2026-08-04). An agent that truly wants
 *    deny-all says `disabledTools: ["*"]` / `disabledFeatureSets: ["*"]`.
 *
 *  - `enabledCapabilities` is dropped: the agent's file can narrow, never
 *    widen — a hand-written entry here could re-grant §13.4 deny-by-default
 *    paths.
 *
 *  - `disabledCapabilities` always carries at least
 *    AGENT_DEPLOY_DENIED_CAPABILITIES (unioned with anything the entry
 *    already denies): self-deployed servers get channels + tools and
 *    nothing consequential by default.
 */
export function resolveOverlayEntry(
  id: string,
  entry: AgentOverlayEntry,
  overlayPath: string,
): ({ id: string; command?: string; url?: string } & Record<string, unknown>) | null {
  if (entry.disabled) return null;
  if (!entry.command && !entry.url) return null;
  const overlayDir = dirname(resolve(overlayPath));
  const { disabled: _d, ...fields } = entry;
  const rec = fields as Record<string, unknown>;
  for (const k of OVERLAY_LIST_FIELDS) {
    if (Array.isArray(rec[k]) && (rec[k] as unknown[]).length === 0) delete rec[k];
  }
  delete rec.enabledCapabilities;
  // A network server the agent deployed should come back when it bounces.
  // reconnect defaulted to false, so an entry that never said `reconnect:
  // true` was severed PERMANENTLY by any server restart — with no signal to
  // anyone — until the agent's own next restart, which for a long-lived
  // resident is days away (Mythos, eventless in eidoverse after the
  // 2026-08-04 door deploy). Websocket entries now default to reconnect
  // unless the entry explicitly says false. Stdio entries keep the old
  // default: reconnect does not respawn a dead child anyway (mcpl_restart
  // is that path), so `true` there would promise something it can't do.
  if (entry.url && rec.reconnect === undefined) rec.reconnect = true;
  const denied = new Set<string>([
    ...AGENT_DEPLOY_DENIED_CAPABILITIES,
    ...(Array.isArray(rec.disabledCapabilities) ? (rec.disabledCapabilities as unknown[]).map(String) : []),
  ]);
  return {
    id,
    ...rec,
    disabledCapabilities: [...denied].sort(),
    ...(entry.args
      ? {
          args: entry.args.map(arg =>
            arg.startsWith('./') || arg.startsWith('../') ? resolve(overlayDir, arg) : arg,
          ),
        }
      : {}),
  };
}

/**
 * Apply the agent overlay to a resolved server list:
 *   - tombstones (`disabled: true`) remove the matching server
 *   - full entries replace an existing server or append a new one
 * Relative `./`/`../` args are resolved against the overlay file's directory.
 */
export function applyAgentOverlay<T extends { id: string }>(
  servers: T[],
  overlayPath: string,
): Array<T | ({ id: string } & Record<string, unknown>)> {
  const overlay = readAgentOverlay(overlayPath);
  if (Object.keys(overlay).length === 0) return servers;

  const result: Array<T | ({ id: string } & Record<string, unknown>)> =
    servers.filter(s => overlay[s.id]?.disabled !== true);

  for (const [id, entry] of Object.entries(overlay)) {
    const loaded = resolveOverlayEntry(id, entry, overlayPath);
    if (!loaded) continue;
    const idx = result.findIndex(s => s.id === id);
    if (idx >= 0) result[idx] = loaded;
    else result.push(loaded);
  }

  return result;
}

/**
 * Read the raw server entries from the config file (for editing).
 * Returns empty object if file doesn't exist.
 */
export function readMcplServersFile(configPath: string): Record<string, ServerFileEntry> {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as McplServersFile;
  return parsed.mcplServers ?? {};
}

/**
 * Write server entries to the config file.
 */
export function saveMcplServers(configPath: string, servers: Record<string, ServerFileEntry>): void {
  const data: McplServersFile = { mcplServers: servers };
  writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Compose the environment for a stdio MCPL child.
 *
 * Two host-owned values ride along with whatever the server entry declares:
 *
 * - `DISCORD_SUPPRESSED_REACTIONS_BASELINE` — the framework's exported
 *   refusal-annotation set (REFUSAL_REACTION_BASELINE, comma-joined), so a
 *   never-configured Discord adapter defaults to suppressing exactly the
 *   markers this host's framework stamps. Placed BEFORE the spread: an
 *   operator who sets the var on the server entry supersedes the house
 *   baseline — the host injects a default, never overrides a decision. The
 *   adapter's own precedence (file key incl. [] → legacy operator env →
 *   baseline) then decides what is actually enforced; house markers are
 *   Host semantics, and a standalone adapter without this composition stays
 *   honestly unprotected.
 * - `AGENT_TIMEZONE` — after the spread, deliberately: the agent-facing
 *   wall clock is resolved per-recipe by the host and is not a per-server
 *   operator knob.
 */
export function composeMcplChildEnv(
  serverEnv: Record<string, string> | undefined,
  timeZone: string,
): Record<string, string> {
  return {
    DISCORD_SUPPRESSED_REACTIONS_BASELINE: REFUSAL_REACTION_BASELINE.join(','),
    ...(serverEnv ?? {}),
    AGENT_TIMEZONE: timeZone,
  };
}
