/**
 * File-driven MCPL server configuration.
 *
 * Reads/writes `mcpl-servers.json` (CC `.mcp.json` shape), keyed by server ID.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

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
 * Resolve an overlay entry into a server config object (id + fields, relative
 * `./`/`../` args resolved against the overlay file's directory). Returns
 * null for tombstones and entries with neither command nor url.
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
  return {
    id,
    ...fields,
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
