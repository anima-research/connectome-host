/**
 * McplAdminModule — lets the agent deploy, restart, and unload its own MCPL
 * servers at runtime, without a host restart.
 *
 * Tools:
 *   - mcpl_list                → configured servers + live connection status
 *   - mcpl_deploy {id, ...}    → add/update a server and hot-connect it
 *   - mcpl_restart {id}        → kill + respawn a server (picks up rebuilt dist)
 *   - mcpl_unload {id}         → disconnect a server and remove its tools
 *
 * Persistence model (agent overlay):
 *   Agent deployments are written to `mcpl-servers.agent.json` (cwd), which
 *   index.ts merges over the recipe/file server list at startup — so agent
 *   deployments survive host restarts without touching human-owned recipe
 *   files or mcpl-servers.json. Unloading a recipe/file server writes a
 *   `{disabled: true}` tombstone to the overlay; unloading an agent-deployed
 *   server just deletes its overlay entry.
 *
 * Security: enabling this module in a recipe grants the agent the ability to
 * spawn arbitrary commands as the host user (mcpl_deploy). Recipe opt-in
 * (`modules: { mcplAdmin: true }`) is the permission gate.
 */

import type {
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  AgentFramework,
  McplServerConfig,
} from '@animalabs/agent-framework';
import { resolveTimeZone } from '@animalabs/agent-framework';
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_AGENT_OVERLAY_PATH,
  readMcplServersFile,
  readAgentOverlay,
  saveAgentOverlay,
  resolveOverlayEntry,
  type AgentOverlayEntry,
} from '../mcpl-config.js';

export interface McplAdminModuleConfig {
  /** IANA zone propagated to newly deployed stdio servers. */
  timeZone?: string;
  /** Path to the agent overlay file. Default: `mcpl-servers.agent.json` in cwd. */
  overlayPath?: string;
  /** Path to the human-owned server config file (read-only here). */
  configPath?: string;
}

function ok(text: string): ToolResult {
  return { success: true, data: text };
}

function fail(text: string): ToolResult {
  return { success: false, error: text, isError: true };
}

export class McplAdminModule implements Module {
  readonly name = 'mcpl-admin';

  private framework: AgentFramework | null = null;
  private overlayPath: string;
  private configPath: string;
  private timeZone: string;

  constructor(config?: McplAdminModuleConfig) {
    this.overlayPath = config?.overlayPath ?? DEFAULT_AGENT_OVERLAY_PATH;
    this.configPath = config?.configPath ?? DEFAULT_CONFIG_PATH;
    this.timeZone = resolveTimeZone(config?.timeZone);
  }

  /** Post-creation wiring (called from index.ts, mirrors ActivityModule.setFramework). */
  setFramework(framework: AgentFramework): void {
    this.framework = framework;
  }

  async start(_ctx: ModuleContext): Promise<void> {}

  async stop(): Promise<void> {
    this.framework = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'mcpl_list',
        description:
          'List all MCPL servers: id, live connection status, tool count, command/url, ' +
          'and where each is defined (recipe/file vs your own agent overlay).',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'mcpl_deploy',
        description:
          'Deploy an MCPL server: persist it to your agent overlay (survives host ' +
          'restarts) and hot-connect it now — its tools become available immediately. ' +
          'If a server with this id is already running it is restarted with the new ' +
          'config. Provide either `command` (stdio, spawned as the host user) or `url` ' +
          '(WebSocket). Relative ./ args resolve against the host working directory.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique server id (also the default tool prefix: mcpl--<id>).' },
            command: { type: 'string', description: 'Executable to spawn (stdio transport). Mutually exclusive with url.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the command.' },
            env: { type: 'object', description: 'Environment variables for the spawned process.' },
            url: { type: 'string', description: 'WebSocket URL (websocket transport). Mutually exclusive with command.' },
            token: { type: 'string', description: 'Bearer token for WebSocket auth.' },
            toolPrefix: { type: 'string', description: 'Tool namespace prefix. Default: mcpl--<id>.' },
            reconnect: { type: 'boolean', description: 'Auto-reconnect on transport failure (default false). Note: does NOT respawn a crashed child — use mcpl_restart for that.' },
            enabledFeatureSets: { type: 'array', items: { type: 'string' } },
            disabledFeatureSets: { type: 'array', items: { type: 'string' } },
            enabledTools: { type: 'array', items: { type: 'string' }, description: 'Tool allow-list (bare names, * wildcard).' },
            disabledTools: { type: 'array', items: { type: 'string' }, description: 'Tool deny-list; wins over enabledTools.' },
          },
          required: ['id'],
        },
      },
      {
        name: 'mcpl_restart',
        description:
          'Restart an MCPL server: kill the process and respawn it with its current ' +
          'config. Use after rebuilding a server\'s dist, or to recover a crashed ' +
          'server (reconnect:true does not respawn dead children — this does). ' +
          'CAUTION: restarting the server that carries your active conversation ' +
          '(e.g. discord) briefly interrupts your own message delivery; it reconnects ' +
          'within a few seconds.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Server id to restart.' },
          },
          required: ['id'],
        },
      },
      {
        name: 'mcpl_unload',
        description:
          'Unload an MCPL server: disconnect it and remove its tools from your ' +
          'toolset. By default this persists (an unloaded recipe server stays ' +
          'unloaded after host restarts; an agent-deployed server is deleted from ' +
          'your overlay). Pass persist:false to unload for this session only. ' +
          'WARNING: unloading the server that carries your conversation (e.g. ' +
          'discord) cuts your own communication channel — you would need another ' +
          'route (or a human) to get it back.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Server id to unload.' },
            persist: { type: 'boolean', description: 'Persist across host restarts (default true).' },
          },
          required: ['id'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const input = (call.input ?? {}) as Record<string, unknown>;
    try {
      switch (call.name) {
        case 'mcpl_list':
          return this.handleList();
        case 'mcpl_deploy':
          return await this.handleDeploy(input);
        case 'mcpl_restart':
          return await this.handleRestart(input);
        case 'mcpl_unload':
          return await this.handleUnload(input);
        default:
          return fail(`Unknown tool: ${call.name}`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return fail(`${call.name} failed: ${err.message}`);
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private requireFramework(): AgentFramework {
    if (!this.framework) {
      throw new Error('mcpl-admin module is not wired to the framework yet');
    }
    return this.framework;
  }

  private handleList(): ToolResult {
    const framework = this.requireFramework();
    const live = framework.listMcplServers();
    const overlay = readAgentOverlay(this.overlayPath);
    const fileServers = readMcplServersFile(this.configPath);

    const lines: string[] = [];
    for (const s of live) {
      const source = overlay[s.id] && !overlay[s.id]!.disabled
        ? 'agent-overlay'
        : s.id in fileServers ? 'file/recipe' : 'recipe';
      const target = s.command ?? s.url ?? '?';
      lines.push(
        `${s.id}: ${s.connected ? 'CONNECTED' : 'DISCONNECTED'} — ${s.toolCount} tools, ` +
        `prefix=${s.toolPrefix}, source=${source}, ${target}`,
      );
    }

    // Tombstoned / overlay-only entries that aren't currently loaded
    const liveIds = new Set(live.map(s => s.id));
    for (const [id, entry] of Object.entries(overlay)) {
      if (entry.disabled) {
        lines.push(`${id}: UNLOADED (tombstoned in your overlay — redeploy with mcpl_deploy to restore)`);
      } else if (!liveIds.has(id)) {
        lines.push(`${id}: NOT LOADED (in your overlay but not connected — try mcpl_deploy again)`);
      }
    }

    if (lines.length === 0) {
      return ok('No MCPL servers configured. Use mcpl_deploy to add one.');
    }
    return ok(`MCPL servers (${lines.length}):\n` + lines.map(l => `  ${l}`).join('\n'));
  }

  private async handleDeploy(input: Record<string, unknown>): Promise<ToolResult> {
    const framework = this.requireFramework();
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return fail('mcpl_deploy requires a non-empty string `id`.');
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return fail('`id` must match [a-zA-Z0-9_-]+ (it becomes part of tool names).');
    }

    const command = typeof input.command === 'string' ? input.command : undefined;
    const url = typeof input.url === 'string' ? input.url : undefined;
    if (!command && !url) return fail('mcpl_deploy requires either `command` (stdio) or `url` (websocket).');
    if (command && url) return fail('`command` and `url` are mutually exclusive.');

    // Build the overlay entry from recognized fields only.
    const entry: AgentOverlayEntry = {};
    if (command) entry.command = command;
    if (url) { entry.url = url; entry.transport = 'websocket'; }
    if (Array.isArray(input.args)) entry.args = input.args.map(String);
    if (input.env && typeof input.env === 'object') entry.env = input.env as Record<string, string>;
    if (typeof input.token === 'string') entry.token = input.token;
    if (typeof input.toolPrefix === 'string') entry.toolPrefix = input.toolPrefix;
    if (typeof input.reconnect === 'boolean') entry.reconnect = input.reconnect;
    if (Array.isArray(input.enabledFeatureSets)) entry.enabledFeatureSets = input.enabledFeatureSets.map(String);
    if (Array.isArray(input.disabledFeatureSets)) entry.disabledFeatureSets = input.disabledFeatureSets.map(String);
    if (Array.isArray(input.enabledTools)) entry.enabledTools = input.enabledTools.map(String);
    if (Array.isArray(input.disabledTools)) entry.disabledTools = input.disabledTools.map(String);

    // Persist to the overlay first — a connect failure still leaves the entry
    // in place so the agent can fix the server and mcpl_restart it.
    const overlay = readAgentOverlay(this.overlayPath);
    overlay[id] = entry;
    saveAgentOverlay(this.overlayPath, overlay);

    const config = resolveOverlayEntry(id, entry, this.overlayPath) as unknown as McplServerConfig;
    config.env = { ...(config.env ?? {}), AGENT_TIMEZONE: this.timeZone };

    const alreadyLoaded = framework.listMcplServers().some(s => s.id === id);
    try {
      if (alreadyLoaded) {
        await framework.restartMcplServer(id, config);
      } else {
        await framework.connectMcplServer(config);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return fail(
        `Server "${id}" was saved to your overlay but failed to connect: ${err.message}. ` +
        'Fix the server (check command/path/build) and run mcpl_restart, or mcpl_unload to remove it.',
      );
    }

    const status = framework.listMcplServers().find(s => s.id === id);
    return ok(
      `${alreadyLoaded ? 'Redeployed' : 'Deployed'} server "${id}" — connected, ` +
      `${status?.toolCount ?? 0} tools under prefix ${status?.toolPrefix ?? `mcpl--${id}`}. ` +
      'Persisted to your agent overlay (survives host restarts).',
    );
  }

  private async handleRestart(input: Record<string, unknown>): Promise<ToolResult> {
    const framework = this.requireFramework();
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return fail('mcpl_restart requires `id`.');

    await framework.restartMcplServer(id);
    const status = framework.listMcplServers().find(s => s.id === id);
    return ok(
      `Restarted server "${id}" — ${status?.connected ? 'connected' : 'NOT connected'}, ` +
      `${status?.toolCount ?? 0} tools.`,
    );
  }

  private async handleUnload(input: Record<string, unknown>): Promise<ToolResult> {
    const framework = this.requireFramework();
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return fail('mcpl_unload requires `id`.');
    const persist = input.persist !== false;

    const known = framework.listMcplServers().some(s => s.id === id);
    const overlay = readAgentOverlay(this.overlayPath);
    if (!known && !(id in overlay)) {
      return fail(`Server "${id}" is not loaded and not in your overlay.`);
    }

    await framework.disconnectMcplServer(id);

    let persistNote = 'Session-only: it will load again on the next host restart.';
    if (persist) {
      if (overlay[id] && !overlay[id]!.disabled) {
        // Agent-deployed server: forget it entirely.
        delete overlay[id];
        persistNote = 'Removed from your agent overlay.';
      } else {
        // Recipe/file server: tombstone it so it stays unloaded across restarts.
        overlay[id] = { disabled: true };
        persistNote = 'Tombstoned in your overlay — it stays unloaded across host restarts; redeploy with mcpl_deploy to restore.';
      }
      saveAgentOverlay(this.overlayPath, overlay);
    }

    return ok(`Unloaded server "${id}" — its tools are gone from your toolset. ${persistNote}`);
  }
}
